const fs = require('fs');
const path = require('path');

const HANDOFF_NAME = /^(\d{4})-(\d{2})-(\d{2})(?:-(\d+))?\.md$/;
const DAY_MS = 86_400_000;

function handoffKey(name) {
  const match = HANDOFF_NAME.exec(name);
  if (!match) return null;
  return [+match[1], +match[2], +match[3], match[4] ? +match[4] : 0];
}

function orderHandoffs(names) {
  return names.map((name) => [name, handoffKey(name)]).filter(([, key]) => key).sort((a, b) => {
    for (let i = 0; i < 4; i++) {
      const difference = a[1][i] - b[1][i];
      if (difference) return difference;
    }
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  }).map(([name]) => name);
}

function latestHandoff(dir, now = new Date()) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const ordered = orderHandoffs(names);
  if (!ordered.length) return null;
  const file = ordered[ordered.length - 1];
  const key = handoffKey(file);
  const fileDay = Date.UTC(key[0], key[1] - 1, key[2]);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return { file, path: path.join(dir, file), ageDays: Math.round((today - fileDay) / DAY_MS) };
}

function newWindowSignpost(name, {
  handoffRoot,
  noHandoff = [],
  maxAgeDays = 7,
  now = new Date(),
} = {}) {
  if (new Set(noHandoff || []).has(name)) return null;
  const dir = path.join(handoffRoot || path.join(process.cwd(), 'data', 'handoff'), `${name}-handoff`);
  const latest = latestHandoff(dir, now);
  if (!latest) return `You are in a fresh session. No handoff was found in ${dir}.`;
  if (latest.ageDays < 0) {
    return `You are in a fresh session. Read the latest handoff at ${latest.path}. Warning: its filename is dated ${-latest.ageDays} day(s) in the future.`;
  }
  if (latest.ageDays > maxAgeDays) {
    return `You are in a fresh session. Read the latest handoff at ${latest.path}. Warning: it is ${latest.ageDays} days old.`;
  }
  return `You are in a fresh session. Read the latest handoff at ${latest.path}, then continue the work.`;
}

module.exports = { orderHandoffs, latestHandoff, newWindowSignpost };
