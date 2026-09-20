const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');

const TAIL_BYTES = 128 * 1024;
const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 10;

function safePart(value) {
  return `id-${Buffer.from(JSON.stringify(String(value)), 'utf8').toString('base64url')}`;
}

function sessionDirectory(config) {
  return path.join(path.dirname(config.dbPath), 'sessions');
}

function sessionRecordPath(dir, agent) {
  return path.join(dir, `session-${safePart(agent)}.json`);
}

function readSessionRecord(dir, agent, { readFile = fs.readFileSync } = {}) {
  try {
    const record = JSON.parse(readFile(sessionRecordPath(dir, agent), 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    if (record.agent !== agent) return null;
    for (const field of ['windowRef', 'sessionId', 'transcriptPath']) {
      if (typeof record[field] !== 'string' || !record[field].trim()) return null;
    }
    return record;
  } catch {
    return null;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockOwner(lock, { lockReadFile = fs.readFileSync } = {}) {
  try {
    const owner = JSON.parse(lockReadFile(lock, 'utf8'));
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || typeof owner.token !== 'string' || !owner.token) return null;
    return owner;
  } catch {
    return null;
  }
}

function isLockOwnerAlive(owner, { processKill = process.kill } = {}) {
  if (!owner) return false;
  try {
    processKill(owner.pid, 0);
    return true;
  } catch (error) {
    return !error || error.code !== 'ESRCH';
  }
}

function createOwnedLock(lock, {
  lockWriteFile = fs.writeFileSync, lockLink = fs.linkSync, lockUnlink = fs.unlinkSync,
  newLockToken = randomUUID,
} = {}) {
  const owner = { pid: process.pid, token: newLockToken() };
  const prepared = `${lock}.owner-${owner.pid}-${owner.token}.tmp`;
  lockWriteFile(prepared, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  try {
    lockLink(prepared, lock);
  } finally {
    try { lockUnlink(prepared); } catch {}
  }
  return owner;
}

function releaseOwnedLock(lock, owner, deps) {
  const { lockUnlink = fs.unlinkSync } = deps;
  const current = readLockOwner(lock, deps);
  if (!current || current.pid !== owner.pid || current.token !== owner.token) {
    throw new Error(`session record lock ownership lost: ${lock}`);
  }
  lockUnlink(lock);
}

function cleanupAbandonedReclaims(lock, {
  lockReadDir = fs.readdirSync, lockUnlink = fs.unlinkSync, ...deps
} = {}) {
  const dir = path.dirname(lock);
  const prefix = `${path.basename(lock)}.reclaim-`;
  let entries;
  try { entries = lockReadDir(dir); } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const suffix = entry.slice(prefix.length);
    const separator = suffix.indexOf('-');
    const pidText = separator < 0 ? '' : suffix.slice(0, separator);
    if (!/^[1-9]\d*$/.test(pidText)) continue;
    const pid = Number.parseInt(pidText, 10);
    if (!Number.isSafeInteger(pid)
        || isLockOwnerAlive({ pid, token: 'reclaim' }, deps)) continue;
    try { lockUnlink(path.join(dir, entry)); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function reclaimAbandonedLock(lock, deps) {
  const {
    lockLink = fs.linkSync, lockStat = fs.statSync, lockUnlink = fs.unlinkSync,
    newLockToken = randomUUID,
  } = deps;
  const claim = `${lock}.reclaim-${process.pid}-${newLockToken()}`;
  try {
    lockLink(lock, claim);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
  try {
    // The claim pins the observed inode. Two links means only the main path and this
    // reclaimer refer to it, so another reclaimer cannot act on the same observation.
    const owner = readLockOwner(claim, deps);
    if (isLockOwnerAlive(owner, deps)) return false;
    let claimStat;
    let currentStat;
    try {
      claimStat = lockStat(claim);
      currentStat = lockStat(lock);
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
    if (claimStat.dev !== currentStat.dev || claimStat.ino !== currentStat.ino
        || claimStat.nlink !== 2 || currentStat.nlink !== 2) return false;
    lockUnlink(lock);
    return true;
  } finally {
    try { lockUnlink(claim); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
}

function acquireOwnedLock(lock, deadline, deps) {
  const { now = Date.now, wait = sleepSync } = deps;
  while (true) {
    cleanupAbandonedReclaims(lock, deps);
    try {
      return createOwnedLock(lock, deps);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }

    const owner = readLockOwner(lock, deps);
    if (!isLockOwnerAlive(owner, deps)) {
      if (reclaimAbandonedLock(lock, deps)) continue;
      if (now() >= deadline) throw new Error(`session record lock timed out: ${lock}`);
      wait(LOCK_RETRY_MS);
      continue;
    }

    if (now() >= deadline) throw new Error(`session record lock timed out: ${lock}`);
    wait(LOCK_RETRY_MS);
  }
}

function withSessionRecordLock(dir, agent, action, {
  mkdir = fs.mkdirSync, chmod = fs.chmodSync, now = Date.now, wait = sleepSync,
  ...lockDeps
} = {}) {
  mkdir(dir, { recursive: true, mode: 0o700 });
  chmod(dir, 0o700);
  const lock = `${sessionRecordPath(dir, agent)}.lock`;
  const deadline = now() + LOCK_WAIT_MS;
  const deps = { now, wait, ...lockDeps };
  const owner = acquireOwnedLock(lock, deadline, deps);
  try {
    return action();
  } finally {
    releaseOwnedLock(lock, owner, deps);
  }
}

function writeSessionRecordUnlocked(dir, record, {
  mkdir = fs.mkdirSync, writeFile = fs.writeFileSync, chmod = fs.chmodSync,
  rename = fs.renameSync, unlink = fs.unlinkSync,
} = {}) {
  mkdir(dir, { recursive: true, mode: 0o700 });
  chmod(dir, 0o700);
  const file = sessionRecordPath(dir, record.agent);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFile(temp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    chmod(temp, 0o600);
    rename(temp, file);
    chmod(file, 0o600);
  } catch (error) {
    try { unlink(temp); } catch {}
    throw error;
  }
  return file;
}

function writeSessionRecord(dir, record, deps = {}) {
  return withSessionRecordLock(
    dir, record.agent, () => writeSessionRecordUnlocked(dir, record, deps), deps,
  );
}

function updateSessionActivity(dir, agent, expected, deps = {}) {
  return withSessionRecordLock(dir, agent, () => {
    const record = readSessionRecord(dir, agent, deps);
    if (!record || record.windowRef !== expected.windowRef
        || record.sessionId !== expected.sessionId) {
      return { updated: false, file: null };
    }
    record.activity = {
      state: expected.state,
      recordedAt: expected.recordedAt,
      windowRef: expected.windowRef,
      sessionId: expected.sessionId,
    };
    return {
      updated: true,
      file: writeSessionRecordUnlocked(dir, record, deps),
    };
  }, deps);
}

function invalidateMovedRecord(dir, agent, oldRefs, deps = {}) {
  const { readRecord = readSessionRecord, unlink = fs.unlinkSync } = deps;
  return withSessionRecordLock(dir, agent, () => {
    const record = readRecord(dir, agent);
    if (!record || !new Set(oldRefs || []).has(record.windowRef)) return false;
    unlink(sessionRecordPath(dir, agent));
    return true;
  }, deps);
}

function sessionActivity(record, currentRef) {
  if (!record || record.windowRef !== currentRef) return null;
  const activity = record.activity;
  if (!activity || typeof activity !== 'object' || Array.isArray(activity)) return null;
  if (activity.state !== 'busy' && activity.state !== 'idle') return null;
  if (activity.windowRef !== record.windowRef || activity.sessionId !== record.sessionId) return null;
  if (typeof activity.recordedAt !== 'string' || !activity.recordedAt) return null;
  return activity;
}

function readTail(file, maxBytes = TAIL_BYTES, fsImpl = fs) {
  const fd = fsImpl.openSync(file, 'r');
  try {
    const size = fsImpl.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const bytesRead = fsImpl.readSync(fd, buffer, 0, length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    return text;
  } finally {
    fsImpl.closeSync(fd);
  }
}

function measureTokens(tail) {
  const lines = String(tail || '').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes('usage')) continue;
    let row;
    try { row = JSON.parse(lines[index]); } catch { continue; }
    const usage = row && row.message && row.message.usage ? row.message.usage : row && row.usage;
    if (!usage || typeof usage !== 'object') continue;
    const parts = [
      usage.input_tokens,
      usage.cache_creation_input_tokens,
      usage.cache_read_input_tokens,
    ].map((value) => value === undefined ? 0 : value);
    if (parts.some((value) => !Number.isFinite(value) || value < 0)) continue;
    const value = parts.reduce((sum, part) => sum + part, 0);
    if (value > 0) return value;
  }
  return null;
}

function measureMarker(file, marker, {
  exec = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 8000 }),
} = {}) {
  let output;
  try { output = exec('grep', ['-F', '-c', '--', marker, file]); }
  catch (error) {
    if (error && error.status === 1) return 0;
    throw error;
  }
  const value = Number.parseInt(String(output).trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function rotationRules(rotation) {
  if (!rotation) return [];
  return Array.isArray(rotation) ? rotation : [rotation];
}

function measure(record, rotation, {
  read = readTail, countMarker = measureMarker, tailBytes = TAIL_BYTES,
} = {}) {
  if (!record || !record.transcriptPath) return null;
  let tail;
  const results = [];
  for (const rule of rotationRules(rotation)) {
    let value;
    try {
      if (rule.kind === 'tokens') {
        if (tail === undefined) tail = read(record.transcriptPath, tailBytes);
        value = measureTokens(tail);
      } else if (rule.kind === 'marker') {
        value = countMarker(record.transcriptPath, rule.marker);
      }
    } catch {
      value = null;
    }
    if (Number.isFinite(value)) {
      results.push({ kind: rule.kind, value, limit: rule.limit, over: value >= rule.limit });
    }
  }
  return results.find((result) => result.over) || results[0] || null;
}

function rotateKey(agent, sessionId, now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const hour = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}`;
  return `rotate:${agent}:${sessionId}:${hour}`;
}

function rotateSourceState(item, currentRef, currentRecord) {
  if (!item || item.kind !== 'rotate') return 'match';
  const recordRef = currentRecord && currentRecord.windowRef;
  const refs = [item.rotateWindowRef, currentRef, recordRef];
  const ref = refs.every(Boolean)
    ? (new Set(refs).size === 1 ? 'match' : 'stale')
    : 'unknown';
  const sessionId = currentRecord && currentRecord.sessionId;
  const session = sessionId && item.rotateSessionId
    ? (sessionId === item.rotateSessionId ? 'match' : 'stale')
    : 'unknown';
  if (ref === 'stale' || session === 'stale') return 'stale';
  if (ref === 'unknown' || session === 'unknown') return 'unknown';
  return 'match';
}

function formatMeasurement(measurement) {
  if (measurement.kind === 'marker') {
    return `${measurement.value} matching marker line(s), configured limit ${measurement.limit}`;
  }
  return `${measurement.value} context token(s), configured limit ${measurement.limit}`;
}

function localDate(now) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function rotateBody(agent, measurement, handoffDir, now = new Date()) {
  const handoff = path.join(handoffDir, `${agent}-handoff`, `${localDate(now)}.md`);
  return [
    `Session rotation reminder: this session reports ${formatMeasurement(measurement)}.`,
    `At a clean stopping point, finish the current work before taking anything new, write a handoff to ${handoff}, then start a new session yourself.`,
    'This is only a reminder. mousecrew will not rotate the session for you.',
  ].join('\n');
}

module.exports = {
  TAIL_BYTES, sessionDirectory, sessionRecordPath, readSessionRecord, writeSessionRecord,
  updateSessionActivity, invalidateMovedRecord, sessionActivity,
  readTail, measureTokens, measureMarker, rotationRules, measure,
  rotateKey, rotateSourceState, rotateBody, formatMeasurement,
};
