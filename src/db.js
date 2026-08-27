// db.js — one SQLite file. No migrations framework on purpose:
// added columns go through idempotent ALTERs so an existing database upgrades in place.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      channel TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts DATETIME DEFAULT (datetime('now')),
      metadata TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo TEXT,
      description TEXT,
      created_at DATETIME DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS work_orders (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      parent_order_id TEXT REFERENCES work_orders(id),
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      assignee TEXT,
      repo TEXT,
      priority INTEGER DEFAULT 0,
      commit_hash TEXT,
      git_branch TEXT,
      files_changed TEXT,
      blocked_by TEXT,
      pause_reason TEXT,
      needs_restart INTEGER DEFAULT 1,
      timeline TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT (datetime('now')),
      updated_at DATETIME DEFAULT (datetime('now')),
      completed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS agent_logs (
      id INTEGER PRIMARY KEY,
      work_order_id TEXT NOT NULL REFERENCES work_orders(id),
      agent_name TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT,
      ts DATETIME DEFAULT (datetime('now'))
    );

    -- A thread is a piece of work that can be put down and picked back up. Orders are for
    -- work that goes through the board; threads are for everything that does not — the idea
    -- from last night, the half-finished thing, the one you will get back to. Those are the
    -- ones that get lost, because nothing was ever opened for them.
    --
    -- Every constraint below is load-bearing. See lib/thread-rules.js for why each exists.
    CREATE TABLE IF NOT EXISTS threads (
      name        TEXT PRIMARY KEY,
      owner       TEXT NOT NULL CHECK (length(trim(owner)) > 0),
      -- Five states, enforced by the database. Free-text status drifts into dozens of
      -- phrasings and then nobody can filter on it. An enum is cruel and also a mercy.
      status      TEXT NOT NULL DEFAULT 'idea'
                  CHECK (status IN ('idea', 'todo', 'doing', 'blocked', 'done')),
      goal        TEXT NOT NULL DEFAULT '',
      -- One next action, concrete enough to start on. This is the handle you leave behind.
      next        TEXT NOT NULL DEFAULT '',
      blocked_by  TEXT NOT NULL DEFAULT '',
      -- Waiting on a person, not on another thread. Kept separate so a board can show it.
      needs_human TEXT NOT NULL DEFAULT '',
      -- Written only by /finish, and required before status may become 'done'.
      snapshot    TEXT NOT NULL DEFAULT '',
      -- One-way index: a new thread points at the old one. Deliberately not bidirectional —
      -- two writes to keep in step is two chances to end up half-updated.
      prev        TEXT REFERENCES threads(name),
      -- Archive is a soft delete. There is no hard delete and there will not be one.
      archived_at DATETIME,
      created_at  DATETIME DEFAULT (datetime('now')),
      updated_at  DATETIME DEFAULT (datetime('now'))
    );

    -- The plan is current state, not history: ticking a box is an edit, and un-ticking one
    -- has to be possible too, because "where we are now" can be wrong.
    CREATE TABLE IF NOT EXISTS thread_plan (
      thread_name TEXT NOT NULL REFERENCES threads(name) ON DELETE CASCADE,
      idx         INTEGER NOT NULL CHECK (idx >= 1),
      done        INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
      text        TEXT NOT NULL CHECK (length(trim(text)) > 0),
      PRIMARY KEY (thread_name, idx)
    );

    -- The log is history. One line per real step, append-only.
    CREATE TABLE IF NOT EXISTS thread_log (
      id          INTEGER PRIMARY KEY,
      thread_name TEXT NOT NULL REFERENCES threads(name) ON DELETE CASCADE,
      at          DATETIME DEFAULT (datetime('now')),
      who         TEXT NOT NULL CHECK (length(trim(who)) > 0),
      what        TEXT NOT NULL CHECK (length(trim(what)) > 0)
    );

    -- Append-only is enforced here rather than in the route, because a rule that lives in
    -- one handler is a rule until someone writes a second handler. Nobody can rewrite or
    -- remove a log line — including whoever wrote it, five seconds later, having realised
    -- it was wrong. The correction goes on the next line.
    --
    -- This is also why archiving is a soft delete: SQLite has no DISABLE TRIGGER, so the
    -- only way to hard-delete would be DROP TRIGGER → delete → recreate, and for those few
    -- seconds the door is genuinely unlocked. Taking the lock off the door to empty the bin
    -- is not a trade worth making for a bin nobody needs emptied.
    CREATE TRIGGER IF NOT EXISTS thread_log_no_update
      BEFORE UPDATE ON thread_log
      BEGIN SELECT RAISE(ABORT, 'thread_log is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS thread_log_no_delete
      BEFORE DELETE ON thread_log
      BEGIN SELECT RAISE(ABORT, 'thread_log is append-only'); END;

    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, ts);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON work_orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_assignee ON work_orders(assignee);
    CREATE INDEX IF NOT EXISTS idx_orders_blocked ON work_orders(blocked_by);
    CREATE INDEX IF NOT EXISTS idx_logs_order ON agent_logs(work_order_id);
    CREATE INDEX IF NOT EXISTS idx_threads_owner ON threads(owner);
    CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
    CREATE INDEX IF NOT EXISTS idx_thread_log_name ON thread_log(thread_name, id);
  `);

  // Idempotent column adds for databases created by an older version.
  for (const sql of [
    'ALTER TABLE work_orders ADD COLUMN repo TEXT',
    'ALTER TABLE work_orders ADD COLUMN git_branch TEXT',
  ]) {
    try { db.exec(sql); } catch { /* already there */ }
  }

  const msg = {
    insert: db.prepare('INSERT INTO messages (channel, role, content, ts, metadata) VALUES (?, ?, ?, ?, ?)'),
    recent: db.prepare('SELECT content, metadata, ts, role FROM messages WHERE channel = ? ORDER BY ts DESC, id DESC LIMIT ?'),
  };

  const order = {
    all: db.prepare('SELECT * FROM work_orders ORDER BY created_at DESC'),
    getById: db.prepare('SELECT * FROM work_orders WHERE id = ?'),
    getByStatus: db.prepare('SELECT * FROM work_orders WHERE status = ?'),
    getBlockedBy: db.prepare("SELECT * FROM work_orders WHERE blocked_by = ? AND status = 'paused'"),
    create: db.prepare(`INSERT INTO work_orders (id, project_id, title, description, status, assignee, repo, created_by, timeline)
                        VALUES (@id, @project_id, @title, @description, @status, @assignee, @repo, @created_by, @timeline)`),
    setBlockFields: db.prepare('UPDATE work_orders SET blocked_by = ?, pause_reason = ? WHERE id = ?'),
    setNeedsRestart: db.prepare('UPDATE work_orders SET needs_restart = ? WHERE id = ?'),
    setAssignee: db.prepare('UPDATE work_orders SET assignee = ? WHERE id = ?'),
    setCommitFields: db.prepare('UPDATE work_orders SET commit_hash = ?, git_branch = ?, files_changed = ? WHERE id = ?'),
    setBranch: db.prepare('UPDATE work_orders SET git_branch = ? WHERE id = ?'),
    nextSeq: db.prepare("SELECT COUNT(*) AS n FROM work_orders"),
  };

  const log = {
    insert: db.prepare('INSERT INTO agent_logs (work_order_id, agent_name, action, detail) VALUES (?, ?, ?, ?)'),
    byOrder: db.prepare('SELECT * FROM agent_logs WHERE work_order_id = ? ORDER BY ts ASC'),
  };

  const project = {
    all: db.prepare('SELECT * FROM projects ORDER BY created_at DESC'),
    getById: db.prepare('SELECT * FROM projects WHERE id = ?'),
    upsert: db.prepare('INSERT INTO projects (id, name, repo, description) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, repo = excluded.repo'),
  };

  const thread = {
    all: db.prepare('SELECT * FROM threads WHERE archived_at IS NULL ORDER BY updated_at DESC'),
    allWithArchived: db.prepare('SELECT * FROM threads ORDER BY updated_at DESC'),
    get: db.prepare('SELECT * FROM threads WHERE name = ?'),
    getLive: db.prepare('SELECT * FROM threads WHERE name = ? AND archived_at IS NULL'),
    create: db.prepare(`INSERT INTO threads (name, owner, status, goal, next, prev)
                        VALUES (?, ?, ?, ?, ?, ?)`),
    touch: db.prepare("UPDATE threads SET updated_at = datetime('now') WHERE name = ?"),
    // One statement per settable field. A single UPDATE built from a field name would be
    // the place where `plan` and `snapshot` sneak back in — see thread-rules.SETTABLE.
    setOwner: db.prepare("UPDATE threads SET owner = ?, updated_at = datetime('now') WHERE name = ?"),
    setStatus: db.prepare("UPDATE threads SET status = ?, updated_at = datetime('now') WHERE name = ?"),
    setGoal: db.prepare("UPDATE threads SET goal = ?, updated_at = datetime('now') WHERE name = ?"),
    setNext: db.prepare("UPDATE threads SET next = ?, updated_at = datetime('now') WHERE name = ?"),
    setBlockedBy: db.prepare("UPDATE threads SET blocked_by = ?, updated_at = datetime('now') WHERE name = ?"),
    setNeedsHuman: db.prepare("UPDATE threads SET needs_human = ?, updated_at = datetime('now') WHERE name = ?"),
    setPrev: db.prepare("UPDATE threads SET prev = ?, updated_at = datetime('now') WHERE name = ?"),
    // finish() is the only writer of snapshot, and it moves status in the same statement so
    // the two can never disagree. A thread cannot be done without a snapshot, ever.
    finish: db.prepare(`UPDATE threads SET snapshot = ?, status = 'done', updated_at = datetime('now')
                        WHERE name = ?`),
    archive: db.prepare("UPDATE threads SET archived_at = datetime('now'), updated_at = datetime('now') WHERE name = ?"),
    unarchive: db.prepare("UPDATE threads SET archived_at = NULL, updated_at = datetime('now') WHERE name = ?"),
  };

  const threadPlan = {
    byThread: db.prepare('SELECT idx, done, text FROM thread_plan WHERE thread_name = ? ORDER BY idx ASC'),
    clear: db.prepare('DELETE FROM thread_plan WHERE thread_name = ?'),
    insert: db.prepare('INSERT INTO thread_plan (thread_name, idx, done, text) VALUES (?, ?, ?, ?)'),
    setDone: db.prepare('UPDATE thread_plan SET done = ? WHERE thread_name = ? AND idx = ?'),
    get: db.prepare('SELECT * FROM thread_plan WHERE thread_name = ? AND idx = ?'),
  };

  const threadLog = {
    byThread: db.prepare('SELECT at, who, what FROM thread_log WHERE thread_name = ? ORDER BY id ASC'),
    insert: db.prepare('INSERT INTO thread_log (thread_name, who, what) VALUES (?, ?, ?)'),
  };

  return { db, msg, order, log, project, thread, threadPlan, threadLog, close: () => db.close() };
}

module.exports = { open };
