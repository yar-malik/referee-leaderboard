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

// ── Mail ─────────────────────────────────────────────────────────────────────
// Password resets need a sender. Set RESEND_API_KEY and MAIL_FROM (a verified sender on your domain) to enable.
export const mailEnabled = () => Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);

export const sendMail = async ({ to, subject, text }) => {
  if (!mailEnabled()) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to, subject, text }),
  });
  if (!res.ok) console.error('mail failed', res.status, await res.text().catch(() => ''));
  return res.ok;
};
