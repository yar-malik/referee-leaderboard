// Fan polls, discussion and accounts API. One-tap votes with a club, comments under each question,
// and member accounts (email, username, club, flair).
// Dependency-free on purpose. State lives in memory and is rebuilt on start from an append-only
// JSONL event log, which doubles as the backup. Fine for a prototype; move to Postgres at scale.
//
//   PORT=4071 DATA_DIR=./.community WEBROOT=./dist node server/community.mjs
//
// Env: ADMIN_TOKEN (moderation and sign-up export), SALT (IP hashing), WEBROOT (reads community.json,
// the build-generated list of valid polls and clubs), SITE_URL (links in emails),
// RESEND_API_KEY + MAIL_FROM (optional, enables password reset emails).
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { moderate } from './moderation.mjs';
import {
  checkEmail,
  checkPassword,
  checkUsername,
  cleanFlair,
  hashPassword,
  hashToken,
  mailEnabled,
  newToken,
  normaliseEmail,
  resetEmail,
  sendMail,
  verifyPassword,
} from './accounts.mjs';

const PORT = Number(process.env.PORT ?? 4071);
const DATA_DIR = process.env.DATA_DIR ?? './.community';
const WEBROOT = process.env.WEBROOT ?? './dist';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const SALT = process.env.SALT ?? 'dev-salt';
const REPORTS_TO_HIDE = 3;
const SESSION_DAYS = 60;
const CLUB_CHANGE_DAYS = 7;
const LOG = join(DATA_DIR, 'events.jsonl');
const DAY = 86_400_000;

mkdirSync(DATA_DIR, { recursive: true });

// ── Manifest: which polls exist and which clubs can vote ─────────────────────
let manifest = { polls: {}, clubs: new Set(), posts: {} };
let manifestMtime = 0;
const loadManifest = () => {
  const file = join(WEBROOT, 'community.json');
  try {
    const mtime = statSync(file).mtimeMs;
    if (mtime === manifestMtime) return;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    manifest = {
      polls: Object.fromEntries(raw.polls.map((p) => [p.id, p])),
      clubs: new Set(raw.clubs),
      posts: Object.fromEntries((raw.posts ?? []).map((p) => [p.id, p])),
    };
    manifestMtime = mtime;
  } catch (e) {
    console.error('manifest:', e.message);
  }
};
loadManifest();
setInterval(loadManifest, 30_000).unref();

// ── State ────────────────────────────────────────────────────────────────────
/** poll id → Map(voter → { choice, club }) */
const votes = new Map();
/** thread id → comment[] (oldest first) */
const threads = new Map();
/** comment id → comment */
const comments = new Map();
/** post id → Map(voter → 1 | -1) */
const postVotes = new Map();
/** user id → user; plus lookups by email, lowercased username and voter id */
const users = new Map();
const byEmail = new Map();
const byName = new Map();
const byVoter = new Map();
/** hashed token → { user, exp } */
const sessions = new Map();
const resets = new Map();

const indexUser = (u) => {
  byEmail.set(u.email, u);
  byName.set(u.username.toLowerCase(), u);
  byVoter.set(u.voter, u);
};

const apply = (e) => {
  switch (e.t) {
    case 'vote': {
      if (!votes.has(e.poll)) votes.set(e.poll, new Map());
      votes.get(e.poll).set(e.voter, { choice: e.choice, club: e.club });
      break;
    }
    case 'comment': {
      const c = { ...e, parent: e.parent ?? null, votes: new Map(), reports: new Set(), removed: false };
      comments.set(c.id, c);
      if (!threads.has(c.thread)) threads.set(c.thread, []);
      threads.get(c.thread).push(c);
      break;
    }
    // 'like' is the original one-way upvote; 'cvote' replaced it with up/down.
    case 'like': {
      const c = comments.get(e.comment);
      if (c) e.on ? c.votes.set(e.voter, 1) : c.votes.delete(e.voter);
      break;
    }
    case 'cvote': {
      const c = comments.get(e.comment);
      if (c) e.dir ? c.votes.set(e.voter, e.dir) : c.votes.delete(e.voter);
      break;
    }
    case 'pvote': {
      if (!postVotes.has(e.post)) postVotes.set(e.post, new Map());
      e.dir ? postVotes.get(e.post).set(e.voter, e.dir) : postVotes.get(e.post).delete(e.voter);
      break;
    }
    case 'report':
      comments.get(e.comment)?.reports.add(e.voter);
      break;
    case 'remove': {
      const c = comments.get(e.comment);
      if (c) c.removed = true;
      break;
    }
    case 'restore': {
      const c = comments.get(e.comment);
      if (c) {
        c.removed = false;
        c.reports.clear();
      }
      break;
    }
    case 'user': {
      const u = { id: e.id, email: e.email, username: e.username, hash: e.hash, club: e.club, flair: e.flair, marketing: e.marketing, voter: e.voter, createdAt: e.ts, clubChangedAt: e.ts };
      users.set(u.id, u);
      indexUser(u);
      break;
    }
    case 'user-update': {
      const u = users.get(e.id);
      if (!u) break;
      byName.delete(u.username.toLowerCase());
      if ('club' in e.fields && e.fields.club !== u.club) u.clubChangedAt = e.ts;
      Object.assign(u, e.fields);
      indexUser(u);
      break;
    }
    case 'password': {
      const u = users.get(e.user);
      if (u) u.hash = e.hash;
      for (const [k, s] of sessions) if (s.user === e.user) sessions.delete(k);
      break;
    }
    case 'session':
      sessions.set(e.token, { user: e.user, exp: e.exp });
      break;
    case 'logout':
      sessions.delete(e.token);
      break;
    case 'reset':
      resets.set(e.token, { user: e.user, exp: e.exp });
      break;
    case 'reset-used':
      resets.delete(e.token);
      break;
    // A member logged in on a device where they'd already voted: those votes join their account.
    case 'merge': {
      for (const vs of [...votes.values(), ...postVotes.values(), ...[...comments.values()].map((c) => c.votes)]) {
        const v = vs.get(e.from);
        if (v === undefined) continue;
        if (!vs.has(e.to)) vs.set(e.to, v);
        vs.delete(e.from);
      }
      break;
    }
    case 'user-delete': {
      const u = users.get(e.id);
      if (!u) break;
      users.delete(u.id);
      byEmail.delete(u.email);
      byName.delete(u.username.toLowerCase());
      byVoter.delete(u.voter);
      for (const [k, s] of sessions) if (s.user === u.id) sessions.delete(k);
      for (const c of comments.values()) if (c.user === u.id) c.user = 'deleted';
      break;
    }
  }
};

if (existsSync(LOG)) {
  for (const line of readFileSync(LOG, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      apply(JSON.parse(line));
    } catch {}
  }
}
const record = (e) => {
  e.ts ??= Date.now();
  appendFileSync(LOG, JSON.stringify(e) + '\n', { mode: 0o600 });
  apply(e);
};

/** Account deletion: rewrite the log so the member's email, password hash and sessions are gone for good. */
const purgeUser = (id) => {
  const PERSONAL = new Set(['user', 'user-update', 'password', 'session', 'logout', 'reset', 'reset-used']);
  const kept = readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return [];
      }
      if (PERSONAL.has(e.t) && (e.id === id || e.user === id)) return [];
      if (e.t === 'comment' && e.user === id) e.user = 'deleted';
      return [JSON.stringify(e)];
    });
  kept.push(JSON.stringify({ t: 'user-delete', id, ts: Date.now() }));
  const tmp = `${LOG}.tmp`;
  writeFileSync(tmp, kept.join('\n') + '\n', { mode: 0o600 });
  renameSync(tmp, LOG);
  apply({ t: 'user-delete', id });
};

// ── Rate limiting (per hashed IP) ────────────────────────────────────────────
const buckets = new Map();
const LIMITS = {
  vote: [40, 60_000],
  comment: [4, 5 * 60_000],
  commentDay: [30, DAY],
  act: [120, 60_000],
  signup: [5, 3_600_000],
  login: [10, 15 * 60_000],
  forgot: [5, 3_600_000],
  forgotAccount: [3, 3_600_000],
  profile: [30, 3_600_000],
};
const allow = (key, kind) => {
  const [max, windowMs] = LIMITS[kind];
  const now = Date.now();
  const k = `${kind}:${key}`;
  const hits = (buckets.get(k) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  buckets.set(k, hits);
  return true;
};
setInterval(() => buckets.clear(), DAY).unref();

// ── Summaries ────────────────────────────────────────────────────────────────
const visible = (c) => !c.removed && c.reports.size < REPORTS_TO_HIDE;

const summary = (pollId) => {
  const p = manifest.polls[pollId];
  const n = p?.options.length ?? 2;
  const counts = Array(n).fill(0);
  const byClub = {};
  for (const { choice, club } of votes.get(pollId)?.values() ?? []) {
    counts[choice]++;
    const k = club ?? 'none';
    byClub[k] ??= Array(n).fill(0);
    byClub[k][choice]++;
  }
  const discussion = (threads.get(pollId) ?? []).filter(visible).length;
  return { total: counts.reduce((a, b) => a + b, 0), counts, byClub, comments: discussion };
};

/** New accounts can fix their club on day one; after that, one change a week keeps fanbase numbers honest. */
const nextClubChange = (u) => (Date.now() - u.createdAt < DAY ? 0 : u.clubChangedAt + CLUB_CHANGE_DAYS * DAY);
const publicUser = (u) =>
  u ? { id: u.id, username: u.username, email: u.email, club: u.club, flair: u.flair, marketing: u.marketing, createdAt: u.createdAt, canChangeClubAt: nextClubChange(u) } : null;

const sumVotes = (m) => {
  let n = 0;
  for (const d of m?.values() ?? []) n += d;
  return n;
};

const publicComment = (c, voter, me) => {
  const author = c.user && c.user !== 'deleted' ? users.get(c.user) : null;
  return {
    id: c.id,
    ts: c.ts,
    club: c.club,
    side: c.side,
    name: author ? author.username : c.user === 'deleted' ? '[deleted]' : c.name,
    flair: author?.flair ?? null,
    member: Boolean(author),
    parent: c.parent,
    body: c.body,
    score: sumVotes(c.votes),
    dir: c.votes.get(voter) ?? 0,
    reported: c.reports.has(voter),
    mine: c.voter === voter || Boolean(me && c.user === me.id),
  };
};

/**
 * How much more a club's fans see injustice in decisions involving their club than everyone else does.
 * For each poll, compare the share picking the "grievance" option among the club's fans vs other voters,
 * flipped when the club was the beneficiary. Only polls with enough votes on both sides count.
 */
const oneEyed = (min = 3) => {
  const acc = new Map();
  for (const p of Object.values(manifest.polls)) {
    if (p.grievance == null || !p.harmed || p.options.length !== 2) continue;
    const vs = [...(votes.get(p.id)?.values() ?? [])];
    for (const [clubId, sign] of [
      [p.harmed, 1],
      [p.benefited, -1],
    ]) {
      if (!clubId) continue;
      const mine = vs.filter((v) => v.club === clubId);
      const rest = vs.filter((v) => v.club !== clubId);
      if (mine.length < min || rest.length < min) continue;
      const share = (xs) => xs.filter((v) => v.choice === p.grievance).length / xs.length;
      const gap = sign * (share(mine) - share(rest));
      const cur = acc.get(clubId) ?? { total: 0, polls: 0, voters: 0 };
      cur.total += gap;
      cur.polls++;
      cur.voters += mine.length;
      acc.set(clubId, cur);
    }
  }
  return [...acc.entries()]
    .map(([club, v]) => ({ club, index: Math.round((100 * v.total) / v.polls), polls: v.polls, voters: v.voters }))
    .sort((a, b) => b.index - a.index);
};

/** Activity per hub: votes and comments on its polls, fans who voted as that club, and signed-up members. */
let hubCache = { at: 0, stats: {} };
const hubStats = () => {
  if (Date.now() - hubCache.at < 30_000) return hubCache.stats;
  const stats = {};
  const get = (h) => (stats[h] ??= { votes: 0, comments: 0, fans: new Set(), members: 0 });
  for (const p of Object.values(manifest.polls)) {
    const vs = votes.get(p.id);
    const cs = (threads.get(p.id) ?? []).filter(visible).length;
    // The league hub counts everything; club hubs count their own polls.
    for (const h of new Set(['premier-league', ...(p.hubs ?? [])])) {
      const s = get(h);
      s.votes += vs?.size ?? 0;
      s.comments += cs;
    }
    for (const [voter, v] of vs ?? []) {
      get('premier-league').fans.add(voter);
      if (v.club) get(v.club).fans.add(voter);
    }
  }
  for (const u of users.values()) {
    get('premier-league').members++;
    if (u.club) get(u.club).members++;
  }
  const out = Object.fromEntries(Object.entries(stats).map(([h, s]) => [h, { votes: s.votes, comments: s.comments, fans: s.fans.size, members: s.members }]));
  hubCache = { at: Date.now(), stats: out };
  return out;
};

// ── HTTP ─────────────────────────────────────────────────────────────────────
const readBody = (req) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > 8_000) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(d);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('bad json'));
      }
    });
  });

const cookie = (req, name) => new RegExp(`(?:^|;\\s*)${name}=([a-f0-9]+)`).exec(req.headers.cookie ?? '')?.[1];
const ipHash = (req) => {
  const ip = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? '');
  return createHash('sha256').update(SALT + ip).digest('hex').slice(0, 16);
};
const isAdmin = (req) => {
  const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
  const want = Buffer.from(ADMIN_TOKEN);
  return ADMIN_TOKEN.length >= 16 && got.length === want.length && timingSafeEqual(got, want);
};
const validClub = (c) => c === null || (typeof c === 'string' && manifest.clubs.has(c));
const csv = (rows) => rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  const path = url.pathname.replace(/\/+$/, '');
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const setCookies = [];
  const setCookie = (name, value, maxAge) => setCookies.push(`${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`);
  const send = (status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...(setCookies.length ? { 'set-cookie': setCookies } : {}) });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const ip = ipHash(req);

  // Who's asking: a signed-in member, or an anonymous device.
  const sid = cookie(req, 'cao_sid');
  const session = sid ? sessions.get(hashToken(sid)) : null;
  let me = session && session.exp > Date.now() ? users.get(session.user) : null;
  let voter = me?.voter ?? cookie(req, 'cao_vid');
  if (!voter || voter.length !== 32) {
    voter = randomBytes(16).toString('hex');
    setCookie('cao_vid', voter, 31_536_000);
  }

  const startSession = (u) => {
    const token = newToken();
    record({ t: 'session', token: hashToken(token), user: u.id, exp: Date.now() + SESSION_DAYS * DAY });
    setCookie('cao_sid', token, SESSION_DAYS * 86_400);
    setCookie('cao_vid', u.voter, 31_536_000);
    me = u;
  };

  // Writes must come from our own pages.
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    if (origin && new URL(origin).host !== host) return send(403, { error: 'Cross-site request refused.' });
  }

  try {
    let m;
    if (req.method === 'GET' && path === '/api/health') return send(200, { ok: true, polls: Object.keys(manifest.polls).length, members: users.size, mail: mailEnabled() });

    // ── Accounts ──
    if (req.method === 'GET' && path === '/api/me') return send(200, { user: publicUser(me), mail: mailEnabled() });

    if (req.method === 'POST' && path === '/api/auth/signup') {
      const body = await readBody(req);
      const email = normaliseEmail(body.email);
      const username = String(body.username ?? '').trim();
      const club = body.club ?? null;
      const { flair, error: flairError } = cleanFlair(body.flair);
      const problem = checkEmail(email) ?? checkPassword(body.password) ?? checkUsername(username) ?? flairError;
      if (problem) return send(422, { error: problem });
      if (!validClub(club)) return send(422, { error: 'Pick your club, or "No club".' });
      if (body.terms !== true) return send(422, { error: 'Please agree to the house rules and privacy notice.' });
      if (!allow(ip, 'signup')) return send(429, { error: 'Too many sign-ups from here. Try again later.' });
      if (byEmail.has(email)) return send(409, { error: 'There is already an account with that email. Log in instead.' });
      if (byName.has(username.toLowerCase())) return send(409, { error: 'That username is taken.' });
      // A device that belongs to another member (someone else logged out here) gets a fresh voter id.
      const deviceVoter = byVoter.has(voter) ? randomBytes(16).toString('hex') : voter;
      const id = randomBytes(8).toString('hex');
      record({ t: 'user', id, email, username, hash: await hashPassword(String(body.password)), club, flair, marketing: body.marketing === true, voter: deviceVoter, ip });
      startSession(users.get(id));
      return send(201, { user: publicUser(me) });
    }

    if (req.method === 'POST' && path === '/api/auth/login') {
      if (!allow(ip, 'login')) return send(429, { error: 'Too many attempts. Try again in a few minutes.' });
      const body = await readBody(req);
      const u = byEmail.get(normaliseEmail(body.email));
      if (!u || !(await verifyPassword(String(body.password ?? ''), u.hash))) return send(401, { error: 'That email and password don’t match.' });
      const device = cookie(req, 'cao_vid');
      if (device && device !== u.voter && !byVoter.has(device)) record({ t: 'merge', from: device, to: u.voter });
      startSession(u);
      return send(200, { user: publicUser(me) });
    }

    if (req.method === 'POST' && path === '/api/auth/logout') {
      if (sid) record({ t: 'logout', token: hashToken(sid) });
      setCookie('cao_sid', '', 0);
      setCookie('cao_vid', randomBytes(16).toString('hex'), 31_536_000);
      return send(200, { user: null });
    }

    if (req.method === 'POST' && path === '/api/auth/forgot') {
      if (!mailEnabled()) return send(503, { error: "Password reset emails aren't switched on yet. Contact the site to reset your password." });
      if (!allow(ip, 'forgot')) return send(429, { error: 'Too many requests. Try again later.' });
      const body = await readBody(req);
      const u = byEmail.get(normaliseEmail(body.email));
      // Same answer and timing whether or not the account exists, and at most 3 emails an hour per account.
      if (u && allow(u.id, 'forgotAccount')) {
        const token = newToken();
        record({ t: 'reset', token: hashToken(token), user: u.id, exp: Date.now() + 3_600_000 });
        const site = process.env.SITE_URL ?? `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers.host}`;
        sendMail({ to: u.email, ...resetEmail({ username: u.username, link: `${site}/account/reset/?token=${token}` }) });
      }
      return send(200, { ok: true, message: 'If that email has an account, a reset link is on its way. Check your spam folder too.' });
    }

    if (req.method === 'POST' && path === '/api/auth/reset') {
      const body = await readBody(req);
      const key = hashToken(body.token);
      const r = resets.get(key);
      if (!r || r.exp < Date.now() || !users.has(r.user)) return send(400, { error: 'That reset link has expired. Ask for a new one.' });
      const problem = checkPassword(body.password);
      if (problem) return send(422, { error: problem });
      record({ t: 'password', user: r.user, hash: await hashPassword(String(body.password)) });
      record({ t: 'reset-used', token: key });
      startSession(users.get(r.user));
      return send(200, { user: publicUser(me) });
    }

    if (req.method === 'PATCH' && path === '/api/me') {
      if (!me) return send(401, { error: 'Log in first.' });
      if (!allow(ip, 'profile')) return send(429, { error: 'Slow down a little.' });
      const body = await readBody(req);
      const fields = {};
      if ('club' in body && (body.club ?? null) !== me.club) {
        if (!validClub(body.club ?? null)) return send(422, { error: 'Unknown club.' });
        const next = nextClubChange(me);
        if (next > Date.now()) return send(422, { error: `You can change club again on ${new Date(next).toUTCString().slice(0, 16)}. It keeps the fanbase numbers honest.` });
        fields.club = body.club ?? null;
      }
      if ('flair' in body) {
        const { flair, error } = cleanFlair(body.flair);
        if (error) return send(422, { error });
        fields.flair = flair;
      }
      if ('marketing' in body) fields.marketing = body.marketing === true;
      if ('username' in body && body.username !== me.username) {
        const username = String(body.username ?? '').trim();
        const problem = checkUsername(username);
        if (problem) return send(422, { error: problem });
        const taken = byName.get(username.toLowerCase());
        if (taken && taken.id !== me.id) return send(409, { error: 'That username is taken.' });
        fields.username = username;
      }
      if (Object.keys(fields).length) record({ t: 'user-update', id: me.id, fields });
      return send(200, { user: publicUser(users.get(me.id)) });
    }

    if (req.method === 'DELETE' && path === '/api/me') {
      if (!me) return send(401, { error: 'Log in first.' });
      const body = await readBody(req);
      if (!(await verifyPassword(String(body.password ?? ''), me.hash))) return send(401, { error: 'That password is wrong.' });
      purgeUser(me.id);
      setCookie('cao_sid', '', 0);
      setCookie('cao_vid', randomBytes(16).toString('hex'), 31_536_000);
      return send(200, { user: null, deleted: true });
    }

    // ── Polls ──
    if (req.method === 'GET' && path === '/api/polls') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter((id) => manifest.polls[id]).slice(0, 60);
      const polls = {};
      const mine = {};
      for (const id of ids) {
        polls[id] = summary(id);
        const v = votes.get(id)?.get(voter);
        if (v) mine[id] = v;
      }
      return send(200, { polls, me: mine });
    }

    if (req.method === 'POST' && (m = /^\/api\/polls\/([\w.:-]+)\/vote$/.exec(path))) {
      const poll = manifest.polls[m[1]];
      if (!poll) return send(404, { error: 'Unknown question.' });
      const body = await readBody(req);
      const choice = Number(body.choice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= poll.options.length) return send(400, { error: 'Pick one of the options.' });
      // Members always vote as their account's club.
      const club = me ? me.club : (body.club ?? null);
      if (!validClub(club)) return send(400, { error: 'Unknown club.' });
      if (!allow(ip, 'vote')) return send(429, { error: 'Slow down a little.' });
      record({ t: 'vote', poll: poll.id, voter, ip, choice, club, member: Boolean(me) });
      return send(200, { poll: summary(poll.id), me: votes.get(poll.id).get(voter) });
    }

    // ── Discussion ──
    if (req.method === 'GET' && (m = /^\/api\/threads\/([\w.:-]+)\/comments$/.exec(path))) {
      if (!manifest.polls[m[1]]) return send(404, { error: 'Unknown discussion.' });
      const all = threads.get(m[1]) ?? [];
      const parents = new Set(all.filter(visible).map((c) => c.parent).filter(Boolean));
      const list = all.filter((c) => visible(c) || parents.has(c.id));
      const sorted = url.searchParams.get('sort') === 'new' ? [...list].reverse() : [...list].sort((a, b) => sumVotes(b.votes) - sumVotes(a.votes) || b.ts - a.ts);
      return send(200, {
        comments: sorted.slice(0, 500).map((c) => (visible(c) ? publicComment(c, voter, me) : { id: c.id, ts: c.ts, parent: c.parent, removed: true, score: 0, dir: 0 })),
      });
    }

    if (req.method === 'POST' && (m = /^\/api\/threads\/([\w.:-]+)\/comments$/.exec(path))) {
      const poll = manifest.polls[m[1]];
      if (!poll) return send(404, { error: 'Unknown discussion.' });
      if (!me) return send(401, { error: 'Sign up or log in to join the discussion.' });
      const body = await readBody(req);
      const text = String(body.body ?? '').replace(/\s+\n/g, '\n').trim();
      const problem = moderate(text);
      if (problem) return send(422, { error: problem });
      if (!allow(ip, 'comment') || !allow(ip, 'commentDay')) return send(429, { error: "You're posting a lot. Give it a few minutes." });
      // Replies must point at a comment in the same thread, and threads stop nesting at 10 levels.
      let parent = null;
      if (body.parent) {
        const p = comments.get(String(body.parent));
        if (!p || p.thread !== poll.id || p.removed) return send(422, { error: "That comment isn't there any more." });
        let depth = 1;
        for (let q = p; q.parent && depth < 12; q = comments.get(q.parent)) depth++;
        if (depth >= 10) return send(422, { error: 'This thread is as deep as it goes. Reply further up.' });
        parent = p.id;
      }
      const side = votes.get(poll.id)?.get(voter)?.choice ?? null;
      const id = randomBytes(6).toString('hex');
      record({ t: 'comment', id, thread: poll.id, parent, voter, user: me.id, ip, club: me.club, side, name: null, body: text });
      return send(201, { comment: publicComment(comments.get(id), voter, me) });
    }

    if (req.method === 'POST' && (m = /^\/api\/comments\/([a-f0-9]{12})\/(like|report|vote)$/.exec(path))) {
      const c = comments.get(m[1]);
      if (!c || !visible(c)) return send(404, { error: 'Comment not found.' });
      if (!allow(ip, 'act')) return send(429, { error: 'Slow down a little.' });
      if (m[2] === 'vote') {
        const dir = Number((await readBody(req)).dir);
        if (![1, 0, -1].includes(dir)) return send(400, { error: 'Bad vote.' });
        record({ t: 'cvote', comment: c.id, voter, dir });
      } else if (m[2] === 'like') record({ t: 'cvote', comment: c.id, voter, dir: c.votes.get(voter) === 1 ? 0 : 1 });
      else if (!c.reports.has(voter) && c.voter !== voter) record({ t: 'report', comment: c.id, voter });
      return send(200, { comment: publicComment(c, voter, me), hidden: !visible(c) });
    }

    // ── Posts: Reddit-style up/down votes ──
    if (req.method === 'GET' && path === '/api/posts') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter((id) => manifest.posts[id]).slice(0, 300);
      const posts = {};
      for (const id of ids) {
        const pv = postVotes.get(id);
        posts[id] = { score: sumVotes(pv), dir: pv?.get(voter) ?? 0, comments: (threads.get(manifest.posts[id].thread) ?? []).filter(visible).length };
      }
      return send(200, { posts });
    }

    if (req.method === 'POST' && (m = /^\/api\/posts\/([\w.:-]+)\/vote$/.exec(path))) {
      const post = manifest.posts[m[1]];
      if (!post) return send(404, { error: 'Unknown post.' });
      const dir = Number((await readBody(req)).dir);
      if (![1, 0, -1].includes(dir)) return send(400, { error: 'Bad vote.' });
      if (!allow(ip, 'act')) return send(429, { error: 'Slow down a little.' });
      record({ t: 'pvote', post: post.id, voter, dir });
      const pv = postVotes.get(post.id);
      return send(200, { score: sumVotes(pv), dir: pv?.get(voter) ?? 0 });
    }

    if (req.method === 'GET' && path === '/api/clubs/one-eyed') return send(200, { clubs: oneEyed() });

    if (req.method === 'GET' && path === '/api/hubs/stats') {
      const all = hubStats();
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).slice(0, 40);
      return send(200, { hubs: Object.fromEntries(ids.map((id) => [id, all[id] ?? { votes: 0, comments: 0, fans: 0, members: 0 }])) });
    }

    // ── Admin: moderation and sign-ups ──
    if (path.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(401, { error: 'Admin token required.' });
      if (req.method === 'GET' && path === '/api/admin/reported') {
        const list = [...comments.values()].filter((c) => c.reports.size > 0 || c.removed);
        return send(200, { comments: list.map((c) => ({ ...publicComment(c, ''), thread: c.thread, reports: c.reports.size, removed: c.removed })) });
      }
      if (req.method === 'POST' && (m = /^\/api\/admin\/comments\/([a-f0-9]{12})\/(remove|restore)$/.exec(path))) {
        if (!comments.has(m[1])) return send(404, { error: 'Comment not found.' });
        record({ t: m[2], comment: m[1] });
        return send(200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/admin/users') {
        const list = [...users.values()].sort((a, b) => a.createdAt - b.createdAt);
        const counts = {};
        for (const u of list) counts[u.club ?? 'none'] = (counts[u.club ?? 'none'] ?? 0) + 1;
        if (url.searchParams.get('format') === 'csv') {
          const rows = [['email', 'username', 'club', 'flair', 'marketing_opt_in', 'signed_up']];
          for (const u of list) rows.push([u.email, u.username, u.club ?? '', u.flair ?? '', u.marketing ? 'yes' : 'no', new Date(u.createdAt).toISOString()]);
          return send(200, csv(rows), 'text/csv; charset=utf-8');
        }
        return send(200, { total: list.length, byClub: counts, users: list.map(({ id, username, email, club, flair, marketing, createdAt }) => ({ id, username, email, club, flair, marketing, createdAt })) });
      }
    }

    return send(404, { error: 'Not found.' });
  } catch (e) {
    return send(400, { error: e.message === 'too large' ? 'Too long.' : 'Bad request.' });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`community api on 127.0.0.1:${PORT} · ${Object.keys(manifest.polls).length} polls · ${users.size} members`));
