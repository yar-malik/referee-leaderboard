// Account helpers: validation, password hashing, tokens and the (optional) mailer.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { moderate } from './moderation.mjs';

const scrypt = promisify(scryptCb);

export const hashPassword = async (password) => {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
};

export const verifyPassword = async (password, stored) => {
  const [, salt, hex] = String(stored).split('$');
  if (!salt || !hex) return false;
  const key = await scrypt(password, Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hex, 'hex');
  return key.length === want.length && timingSafeEqual(key, want);
};

/** Tokens go to the browser; only their hashes are stored. */
export const newToken = () => randomBytes(32).toString('hex');
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');

const RESERVED = /^(admin|administrator|mod|moderator|support|staff|official|footyvibe|clearandobvious|proref|pgmol|premierleague|referee|var|deleted|null|undefined)$/i;

export const normaliseEmail = (email) => String(email ?? '').trim().toLowerCase();

export const checkEmail = (email) =>
  email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? 'Enter a valid email address.' : null;

export const checkPassword = (password) => {
  const p = String(password ?? '');
  if (p.length < 8) return 'Use at least 8 characters for your password.';
  if (p.length > 200) return 'That password is too long.';
  return null;
};

export const checkUsername = (username) => {
  const u = String(username ?? '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(u)) return 'Usernames are 3–20 letters, numbers or underscores.';
  if (RESERVED.test(u)) return 'That username is reserved.';
  return moderate(u, { name: true });
};

export const cleanFlair = (flair) => {
  const f = String(flair ?? '').replace(/\s+/g, ' ').trim();
  if (!f) return { flair: null };
  if (f.length > 30) return { error: 'Keep your flair under 30 characters.' };
  const problem = moderate(f, { name: true, max: 30 });
  return problem ? { error: problem } : { flair: f };
};

// ── Google Identity Platform (Firebase Authentication) ──────────────────────
// Passwords, password-reset emails and email confirmation are handled by Google; FootyVibe keeps the
// profile (username, club, flair) and its own session cookie. Set FIREBASE_API_KEY to enable.
export const idpEnabled = () => Boolean(process.env.FIREBASE_API_KEY);

const IDP_MESSAGES = {
  EMAIL_EXISTS: 'There is already an account with that email. Log in instead.',
  INVALID_LOGIN_CREDENTIALS: 'That email and password don’t match.',
  INVALID_PASSWORD: 'That email and password don’t match.',
  EMAIL_NOT_FOUND: 'That email and password don’t match.',
  USER_DISABLED: 'This account has been disabled.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again in a few minutes.',
  EXPIRED_OOB_CODE: 'That link has expired or was already used. Ask for a new one.',
  INVALID_OOB_CODE: 'That link has expired or was already used. Ask for a new one.',
  INVALID_EMAIL: 'Enter a valid email address.',
  MISSING_PASSWORD: 'Enter your password.',
};

export class IdpError extends Error {
  constructor(code) {
    const key = String(code).split(' ')[0].split(':')[0];
    super(key.startsWith('WEAK_PASSWORD') ? 'Use at least 8 characters for your password.' : (IDP_MESSAGES[key] ?? 'Something went wrong. Try again.'));
    this.code = key;
  }
}

/** Calls an Identity Toolkit accounts method (signUp, signInWithPassword, sendOobCode, resetPassword, update, delete). */
export const idp = async (method, body) => {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${process.env.FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new IdpError(data?.error?.message ?? res.status);
  return data;
};
