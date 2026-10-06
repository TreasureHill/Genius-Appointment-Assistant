const crypto = require('crypto');
const env = require('../config/env');

// AES-256-GCM for secrets kept in Mongo (API keys, mailbox passwords). The key
// is derived from APP_ENCRYPTION_KEY, else JWT_SECRET, so a database dump on
// its own never reveals a credential. Format: "v1:<iv>:<tag>:<ciphertext>",
// each part base64.

function keyFor(secret) {
  return crypto.createHash('sha256').update(`genius-secretbox:${secret}`).digest();
}

function currentKey() {
  return keyFor(env.encryptionKey || env.jwtSecret);
}

function encrypt(plain, key = currentKey()) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

// Returns '' for blank input and for anything that can't be decrypted (wrong
// key, tampered value) — callers treat that as "not configured".
function decrypt(box, key = currentKey()) {
  if (!box || typeof box !== 'string') return '';
  const parts = box.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') return '';
  try {
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// "…b4f9" — enough for the owner to recognise which key is stored.
function hint(secret) {
  const s = String(secret || '');
  if (!s) return '';
  return `…${s.slice(-4)}`;
}

module.exports = { encrypt, decrypt, hint, keyFor };
