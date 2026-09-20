const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TAIL_BYTES = 128 * 1024;

function safePart(value) {
  const text = String(value || 'unknown');
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : `id-${Buffer.from(text).toString('base64url')}`;
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

function writeSessionRecord(dir, record, {
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

function invalidateMovedRecord(dir, agent, oldRefs, {
  readRecord = readSessionRecord, unlink = fs.unlinkSync,
} = {}) {
  const record = readRecord(dir, agent);
  if (!record || !new Set(oldRefs || []).has(record.windowRef)) return false;
  unlink(sessionRecordPath(dir, agent));
  return true;
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
  const ref = currentRef && item.rotateWindowRef
    ? (currentRef === item.rotateWindowRef ? 'match' : 'stale')
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
  invalidateMovedRecord, readTail, measureTokens, measureMarker, rotationRules, measure,
  rotateKey, rotateSourceState, rotateBody, formatMeasurement,
};
