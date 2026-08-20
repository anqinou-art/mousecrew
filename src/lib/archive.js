// archive.js — append-only plain-text mirror of the group.
//
// The database is queryable; this file is readable. When something has gone wrong at
// 3am, `tail` on a jsonl beats opening a SQLite browser. It is also the artifact you
// keep when you eventually throw the database away.
const fs = require('fs');
const path = require('path');

function createArchive(archivePath) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  return {
    append(sender, content, type = 'message') {
      const line = JSON.stringify({ ts: new Date().toISOString(), sender, type, content });
      try {
        fs.appendFileSync(archivePath, line + '\n');
      } catch (e) {
        // Never let archiving break delivery — the message getting through matters more.
        console.error('[archive] append failed:', e.message);
      }
    },
    path: archivePath,
  };
}

module.exports = { createArchive };
