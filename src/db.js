// db.js — one SQLite file, four tables. No migrations framework on purpose:
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

    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, ts);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON work_orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_assignee ON work_orders(assignee);
    CREATE INDEX IF NOT EXISTS idx_orders_blocked ON work_orders(blocked_by);
    CREATE INDEX IF NOT EXISTS idx_logs_order ON agent_logs(work_order_id);
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

  return { db, msg, order, log, project, close: () => db.close() };
}

module.exports = { open };
