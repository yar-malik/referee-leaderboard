// The signed-in member, shared by every script on a page. Fetched once; `cao:me` fires when it changes.

export interface Member {
  id: string;
  username: string;
  email: string;
  club: string | null;
  flair: string | null;
  marketing: boolean;
  createdAt: number;
  /** 0 when the club can be changed now, else a timestamp. */
  canChangeClubAt: number;
}

const base = import.meta.env.BASE_URL.replace(/\/$/, '');
export const apiBase = `${base}/api`;
export const accountUrl = (next = location.pathname + location.search) => `${base}/account/?next=${encodeURIComponent(next)}`;

let current: Promise<{ user: Member | null; mail: boolean }> | null = null;

const remember = (user: Member | null) => {
  // Polls read the saved club, so a member's club always wins on this device.
  try {
    if (user) localStorage.setItem('cao-club', user.club ?? 'none');
  } catch {}
};

export const loadMe = () =>
  (current ??= fetch(`${apiBase}/me`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : { user: null, mail: false }))
    .then((d) => {
      remember(d.user);
      return d;
    })
    .catch(() => ({ user: null, mail: false })));

export const setMe = (user: Member | null, mail = false) => {
  current = Promise.resolve({ user, mail });
  remember(user);
  document.dispatchEvent(new CustomEvent('cao:me', { detail: user }));
};

export const api = async (path: string, init?: RequestInit) => {
  const res = await fetch(`${apiBase}${path}`, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? 'Something went wrong. Try again.'), { status: res.status });
  return body;
};

/** Club colours for chips and flair pills: near-white kits use their secondary colour, as ClubBadge does. */
export const clubColours = (primary: string, secondary: string) => {
  const light = (hex: string) => {
    const v = parseInt(hex.slice(1), 16);
    return 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255) > 200;
  };
  const fill = light(primary) ? secondary : primary;
  const ink = fill === primary ? (light(secondary) ? secondary : '#ffffff') : primary;
  return { fill, ink };
};
