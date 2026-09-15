// Browser-side behaviour for /h/ feeds and post pages: post votes, comment counts, sorting, flair filters,
// share, save, relative times and whole-card clicks.
import { api } from './session';

type PostState = { score: number; dir: number; comments: number };

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

const ago = (iso: string) => {
  const days = Math.floor((Date.now() - new Date(`${iso}T15:00:00Z`).getTime()) / 86_400_000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};
const compact = (n: number) => (Math.abs(n) >= 10_000 ? `${Math.round(n / 1000)}k` : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const initH = () => {
  const state = new Map<string, PostState>();

  // Relative times.
  document.querySelectorAll<HTMLElement>('[data-ago]').forEach((el) => (el.textContent = ago(el.dataset.ago!)));

  // Votes and comment counts.
  const paintPost = (id: string) => {
    const s = state.get(id);
    if (!s) return;
    document.querySelectorAll<HTMLElement>(`[data-post-vote="${id}"]`).forEach((box) => {
      box.classList.toggle('up', s.dir === 1);
      box.classList.toggle('down', s.dir === -1);
      box.querySelector('[data-score]')!.textContent = s.score || s.dir ? compact(s.score) : 'Vote';
    });
    document.querySelectorAll<HTMLElement>(`[data-actions="${id}"] [data-comments]`).forEach((el) => {
      el.textContent = s.comments ? `${compact(s.comments)} comment${s.comments === 1 ? '' : 's'}` : 'Comment';
    });
  };

  const ids = [...new Set([...document.querySelectorAll<HTMLElement>('[data-post-vote]')].map((el) => el.dataset.postVote!))];
  const loaded = (async () => {
    for (let i = 0; i < ids.length; i += 300) {
      try {
        const r = await api(`/posts?ids=${ids.slice(i, i + 300).join(',')}`);
        for (const [id, s] of Object.entries(r.posts as Record<string, PostState>)) {
          state.set(id, s);
          paintPost(id);
        }
      } catch {}
    }
  })();

  document.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;

    const voteBtn = t.closest<HTMLButtonElement>('[data-post-vote] [data-dir]');
    if (voteBtn) {
      const id = voteBtn.closest<HTMLElement>('[data-post-vote]')!.dataset.postVote!;
      const s = state.get(id) ?? { score: 0, dir: 0, comments: 0 };
      const want = Number(voteBtn.dataset.dir);
      const dir = s.dir === want ? 0 : want;
      const before = { ...s };
      state.set(id, { ...s, score: s.score + dir - s.dir, dir });
      paintPost(id);
      try {
        const r = await api(`/posts/${id}/vote`, { method: 'POST', body: JSON.stringify({ dir }) });
        state.set(id, { ...state.get(id)!, score: r.score, dir: r.dir });
      } catch {
        state.set(id, before);
      }
      paintPost(id);
      return;
    }

    const share = t.closest<HTMLButtonElement>('[data-share]');
    if (share) {
      const url = new URL(share.dataset.share!, location.origin).toString();
      const label = share.querySelector<HTMLElement>('[data-share-label]');
      try {
        if (navigator.share) await navigator.share({ title: share.dataset.title, url });
        else {
          await navigator.clipboard.writeText(url);
          if (label) label.textContent = 'Copied';
          setTimeout(() => label && (label.textContent = 'Share'), 1800);
        }
      } catch {}
      return;
    }

    const save = t.closest<HTMLButtonElement>('[data-save]');
    if (save) {
      const saved = new Set(JSON.parse(store.get('fv-saved') ?? '[]') as string[]);
      const id = save.dataset.save!;
      saved.has(id) ? saved.delete(id) : saved.add(id);
      store.set('fv-saved', JSON.stringify([...saved]));
      paintSaved();
      return;
    }

    // Clicking anywhere on a feed card that isn't a control opens the post, like Reddit.
    const card = t.closest<HTMLElement>('.post[data-href]');
    if (card && !t.closest('a, button, input, textarea, select, label, .fv, summary')) {
      if (e.metaKey || e.ctrlKey) window.open(card.dataset.href, '_blank');
      else location.href = card.dataset.href!;
    }
  });

  const paintSaved = () => {
    const saved = new Set(JSON.parse(store.get('fv-saved') ?? '[]') as string[]);
    document.querySelectorAll<HTMLElement>('[data-save]').forEach((b) => {
      const on = saved.has(b.dataset.save!);
      b.classList.toggle('saved', on);
      b.querySelector('[data-save-label]')!.textContent = on ? 'Saved' : 'Save';
    });
  };
  paintSaved();

  // Feed sorting (Hot, New, Top) and flair filters.
  const feed = document.querySelector<HTMLElement>('[data-feed]');
  if (!feed) return;
  const cards = [...feed.querySelectorAll<HTMLElement>('.post')];
  let flair = 'all';
  const apply = (mode: string) => {
    const scored = cards.map((el, n) => {
      const s = state.get(el.dataset.post!) ?? { score: 0, dir: 0, comments: 0 };
      const ageHours = Math.max(1, (Date.now() - new Date(`${el.dataset.date}T15:00:00Z`).getTime()) / 3_600_000);
      const hot = (s.score + s.comments * 2 + 1) / Math.pow(ageHours / 24 + 2, 1.4);
      return { el, n, s, hot };
    });
    scored.sort((a, b) =>
      mode === 'new' ? a.n - b.n : mode === 'top' ? b.s.score - a.s.score || b.s.comments - a.s.comments || a.n - b.n : b.hot - a.hot || a.n - b.n,
    );
    for (const { el } of scored) {
      el.hidden = flair !== 'all' && el.dataset.flair !== flair;
      feed.append(el);
    }
    const empty = feed.parentElement?.querySelector<HTMLElement>('[data-feed-empty]');
    if (empty) empty.hidden = scored.some(({ el }) => !el.hidden);
  };
  const sorts = [...document.querySelectorAll<HTMLButtonElement>('[data-sort-mode]')];
  let mode = 'hot';
  sorts.forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.sortMode!;
      sorts.forEach((x) => x.classList.toggle('on', x === b));
      apply(mode);
    }),
  );
  const flairs = [...document.querySelectorAll<HTMLButtonElement>('[data-flair-filter]')];
  flairs.forEach((b) =>
    b.addEventListener('click', () => {
      flair = b.dataset.flairFilter!;
      flairs.forEach((x) => x.classList.toggle('on', x === b));
      apply(mode);
    }),
  );
  loaded.then(() => apply(mode));
};
