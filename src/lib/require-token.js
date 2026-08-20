// require-token.js — bearer token on every API call. No grace mode.
//
// Two rules that look paranoid and are not:
//
// 1. Never authorize by source address. Behind a reverse proxy every public request
//    arrives from 127.0.0.1, so "local requests are trusted" means "everyone is trusted",
//    and the logs look perfectly normal while it happens.
//
// 2. Fail closed. If the token file is missing, unreadable, or world-readable, refuse
//    every request. A system that silently drops its own front door open when
//    misconfigured is worse than one that won't boot.

const crypto = require('crypto');
const fs = require('fs');

function readTokenFile(file) {
  const st = fs.statSync(file);
  // Permissions wider than owner-only mean the secret is already shared; treating the
  // file as valid at that point is just filing the problem away.
  if (st.mode & 0o077) {
    throw new Error(`${file} is group/world accessible (want 0600)`);
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed.token) throw new Error(`${file} has no "token" field`);
  return parsed.token;
}

function parseBearer(header) {
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Constant-time compare so response timing can't be used to guess the token. */
function tokenMatches(presented, expected) {
  if (!presented || !expected) return false;
  const a = Buffer.from(String(presented));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function fingerprint(token) {
  if (!token) return null;
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 6);
}

/**
 * @param {object} opts { tokenFile, loadToken } — loadToken is for tests, so they never
 *   need a real 0600 file on disk.
 * @returns {(req,res,label?) => boolean} true when allowed; on refusal it has ALREADY
 *   written 401, so the caller just returns.
 */
function createRequireToken({ tokenFile, loadToken } = {}) {
  const load = loadToken || (() => readTokenFile(tokenFile));

  return function requireToken(req, res, label = '') {
    let expected;
    try {
      expected = load();
    } catch (e) {
      console.error(`[auth] cannot read token (${e.message}) -> refusing ${label}`);
      res.status(401).json({ error: 'unauthorized' });
      return false;
    }
    const presented = parseBearer(req.headers && req.headers.authorization);
    if (!tokenMatches(presented, expected)) {
      // Log a fingerprint, never the value.
      console.warn(`[auth] 401 ${label} presented=${fingerprint(presented) || 'none'}`);
      res.status(401).json({ error: 'unauthorized' });
      return false;
    }
    return true;
  };
}

module.exports = { createRequireToken, readTokenFile, parseBearer, tokenMatches, fingerprint };
