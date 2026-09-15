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
// Sent through Resend. Set RESEND_API_KEY and MAIL_FROM (an address on a domain verified in Resend) to enable.
// RESEND_API_URL only exists so tests can point at a local stand-in.
export const mailEnabled = () => Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);

export const sendMail = async ({ to, subject, text, html }) => {
  if (!mailEnabled()) return false;
  try {
    const res = await fetch(process.env.RESEND_API_URL ?? 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to, subject, text, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error('mail failed', res.status, await res.text().catch(() => ''));
    return res.ok;
  } catch (e) {
    console.error('mail failed', e.message);
    return false;
  }
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The password reset email, as plain text and a simple HTML version that renders everywhere. */
export const resetEmail = ({ username, link }) => ({
  subject: 'Reset your FootyVibe password',
  text: `Hi ${username},\n\nSomeone asked to reset the password for your FootyVibe account. If it was you, choose a new password here (the link works for one hour and only once):\n\n${link}\n\nIf you didn't ask for this, ignore this email. Your password won't change.\n\nFootyVibe · footyvibe.xyz`,
  html: `<!doctype html><html><body style="margin:0;background:#f4f4f2;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111113">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:32px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;padding:32px">
      <tr><td style="font-size:22px;font-weight:700;letter-spacing:-0.02em;padding-bottom:20px">FootyVibe</td></tr>
      <tr><td style="font-size:16px;line-height:1.55;padding-bottom:20px">Hi ${escapeHtml(username)},<br><br>Someone asked to reset the password for your FootyVibe account. If it was you, choose a new password below. The link works for one hour and only once.</td></tr>
      <tr><td style="padding-bottom:24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#111113;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 24px;border-radius:999px">Choose a new password</a></td></tr>
      <tr><td style="font-size:13px;line-height:1.5;color:#62636b;padding-bottom:16px">Button not working? Paste this into your browser:<br><a href="${escapeHtml(link)}" style="color:#4f46e5;word-break:break-all">${escapeHtml(link)}</a></td></tr>
      <tr><td style="font-size:13px;line-height:1.5;color:#62636b;border-top:1px solid #ececea;padding-top:16px">If you didn't ask for this, ignore this email. Your password won't change.</td></tr>
    </table>
    <p style="font-size:12px;color:#8e8f96;margin:16px 0 0">FootyVibe · footyvibe.xyz</p>
  </td></tr></table></body></html>`,
});
