// Browser-side behaviour shared by hub pages: feed tabs, "this is my club", and live activity counts.
import { api, loadMe, setMe, type Member } from './session';

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

const compact = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const hubClient = () => {
  // Tabs show one kind of feed section, or all of them.
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  for (const t of tabs) {
    t.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.toggle('on', x === t));
      for (const s of document.querySelectorAll<HTMLElement>('.feed > [data-cat]')) {
        s.hidden = t.dataset.tab !== 'all' && s.dataset.cat !== t.dataset.tab;
      }
    });
  }

  // "This is my club" presets the club every poll on the site votes with.
  const joins = [...document.querySelectorAll<HTMLButtonElement>('[data-join]')];
  const paint = () => {
    const mine = store.get('cao-club');
    for (const b of joins) {
      const on = mine === b.dataset.join;
      b.classList.toggle('on', on);
      b.textContent = on ? '✓ Your club' : 'This is my club';
    }
  };
  let member: Member | null = null;
  for (const b of joins) {
    b.addEventListener('click', async () => {
      // Members change their account's club (limited to once a week); guests just save it on this device.
      if (member) {
        if (member.club === b.dataset.join) return;
        if (!confirm(`Make ${document.querySelector('h1')?.textContent ?? 'this'} your club? You can only change club once a week.`)) return;
        try {
          const r = await api('/me', { method: 'PATCH', body: JSON.stringify({ club: b.dataset.join }) });
          setMe(r.user);
        } catch (e) {
          alert((e as Error).message);
        }
        return;
      }
      store.set('cao-club', b.dataset.join!);
      paint();
    });
  }
  document.addEventListener('fv:club', paint);
  document.addEventListener('cao:me', (e) => {
    member = (e as CustomEvent<Member | null>).detail;
    paint();
  });
  loadMe().then((d) => {
    member = d.user;
    paint();
  });
  paint();

  // Votes, comments and fans per hub.
  const slots = [...document.querySelectorAll<HTMLElement>('[data-hub-stats]')];
  if (!slots.length) return;
  const ids = [...new Set(slots.map((s) => s.dataset.hubStats!))];
  const base = document.querySelector<HTMLElement>('[data-api]')?.dataset.api ?? `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;
  fetch(`${base}/hubs/stats?ids=${ids.join(',')}`, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then(({ hubs }: { hubs: Record<string, { votes: number; comments: number; fans: number; members: number }> }) => {
      for (const s of slots) {
        const h = hubs[s.dataset.hubStats!];
        if (!h) continue;
        for (const el of s.querySelectorAll<HTMLElement>('[data-k]')) el.textContent = compact(h[el.dataset.k as 'votes' | 'comments' | 'fans' | 'members'] ?? 0);
      }
    })
    .catch(() => {});
};
