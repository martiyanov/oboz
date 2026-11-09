// Приватный доступ владельца: пароль (scrypt) и подписанные сессионные cookie.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './paths.js';

export const AUTH_FILE = path.join(STATE_DIR, 'auth.json');
export const PASSWORD_FILE = path.join(STATE_DIR, 'private-password.txt');
export const SESSION_SECRET_FILE = path.join(STATE_DIR, 'session-secret');
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'oboz_private';

let state = null;

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function generatePassword() {
  return crypto.randomBytes(24).toString('base64url');
}

async function writeSecretFile(file, content) {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, content, { mode: 0o600 });
}

async function loadSessionSecret() {
  try {
    const raw = (await fs.readFile(SESSION_SECRET_FILE, 'utf8')).trim();
    if (raw.length >= 32) return Buffer.from(raw, 'hex');
  } catch {
    /* создаём ниже */
  }
  const secret = crypto.randomBytes(32);
  await writeSecretFile(SESSION_SECRET_FILE, secret.toString('hex'));
  return secret;
}

async function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt)).toString('hex');
  return { salt, hash };
}

// Вызывается при старте сервера: создаёт auth.json и пароль, если их ещё нет.
export async function ensureAuth(options = {}) {
  const version = options.version || Date.now().toString(36);
  let saved = null;
  let generated = false;
  try {
    saved = JSON.parse(await fs.readFile(AUTH_FILE, 'utf8'));
  } catch {
    /* создаём */
  }
  if (!saved || !saved.salt || !saved.hash) {
    const envPassword = String(process.env.OBOZ_PRIVATE_PASSWORD || '').trim();
    generated = !envPassword;
    const password = envPassword || generatePassword();
    const { salt, hash } = await createPasswordHash(password);
    saved = { version, salt, hash, updatedAt: new Date().toISOString() };
    await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(AUTH_FILE, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    if (generated) {
      await writeSecretFile(PASSWORD_FILE, `${password}\n`);
      if (typeof options.log === 'function') {
        options.log(`private: пароль создан, читайте ${PASSWORD_FILE}`);
      }
    }
  }
  const secret = await loadSessionSecret();
  state = { ...saved, secret };
  return { version: saved.version, generated };
}

export function authVersion() {
  return state ? state.version : null;
}

export async function checkPassword(password) {
  if (!state) await ensureAuth();
  if (typeof password !== 'string' || password.length < 4 || password.length > 200) return false;
  const hash = await scrypt(password, state.salt);
  return safeEqual(hash, Buffer.from(state.hash, 'hex'));
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

export function createSessionToken(now = Date.now()) {
  if (!state) throw new Error('auth module is not initialized');
  const payload = base64url(JSON.stringify({ exp: now + SESSION_TTL_MS, v: state.version }));
  const signature = crypto.createHmac('sha256', state.secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySessionToken(token, now = Date.now()) {
  if (!state || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = crypto.createHmac('sha256', state.secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || typeof data.exp !== 'number' || data.exp < now) return false;
    return data.v === state.version;
  } catch {
    return false;
  }
}

export function parseCookies(header) {
  const out = new Map();
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out.set(key, decodeURIComponent(value));
  }
  return out;
}

export function sessionCookie(token, secure, maxAgeSec = Math.floor(SESSION_TTL_MS / 1000)) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure) {
  return sessionCookie('', secure, 0);
}

// Сброс пароля (используется CLI/тестами): удаляет auth.json; при следующем старте
// пароль будет создан заново (из OBOZ_PRIVATE_PASSWORD или сгенерирован).
export async function resetPassword() {
  await fs.unlink(AUTH_FILE).catch(() => {});
  await fs.unlink(PASSWORD_FILE).catch(() => {});
  state = null;
}
