import type { Topic } from './topics';

export interface Article {
  title: string;
  url: string;
  source: string;
  published: Date | null;
  image?: string;
  summary?: string;
  language?: string;
  country?: string;
}

export interface NewsQuery {
  /** Place names; an article matches if it mentions any of them. */
  places: string[];
  topic: Topic;
  timespan: '24h' | '3d' | '1w' | '1m';
  sort: 'datedesc' | 'hybridrel';
  englishOnly: boolean;
}

export class SupersededError extends Error {
  constructor() {
    super('superseded');
    this.name = 'SupersededError';
  }
}

/** Keep letters (any script), digits, spaces and hyphens — GDELT rejects most punctuation. */
const clean = (s: string) => s.replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// GDELT DOC 2.0 — free, keyless, global, 65+ languages.
// Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
// In practice responses take 5–20 s and GDELT answers "429 Too Many Requests" whenever an IP
// sends more than one request per 5 s. Its 429 responses carry no CORS header, so the browser
// only sees a generic network error. Hence: one request at a time, a gap after each, automatic
// retries with backoff, and a cache that survives reloads.
// ---------------------------------------------------------------------------
const GDELT_GAP_MS = 6000;
const GDELT_TIMEOUT_MS = 45000;
const RETRY_DELAYS_MS = [7000, 15000];
let gdeltFreeAt = 0;
let pending: { run: () => void; reject: (e: Error) => void } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let busy = false;

/** Runs tasks strictly one at a time with a gap in between; a newer task replaces a waiting one. */
function schedule<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending?.reject(new SupersededError());
    pending = { run: () => task().then(resolve, reject), reject };
    pump();
  });
}
function pump() {
  clearTimeout(timer);
  if (busy || !pending) return;
  const wait = Math.max(0, gdeltFreeAt - Date.now());
  timer = setTimeout(() => {
    const job = pending;
    if (!job || busy) return;
    pending = null;
    busy = true;
    job.run();
  }, wait);
}
function release(extraWaitMs = 0) {
  busy = false;
  gdeltFreeAt = Date.now() + GDELT_GAP_MS + extraWaitMs;
  pump();
}

// --- cache (memory + localStorage, 15 min) ---
const CACHE_MS = 15 * 60 * 1000;
const memCache = new Map<string, { at: number; data: Article[] }>();
function cacheGet(url: string): Article[] | null {
  let hit = memCache.get(url);
  if (!hit) {
    try {
      const raw = localStorage.getItem('ng:' + url);
      if (raw) {
        const j = JSON.parse(raw);
        hit = { at: j.at, data: j.data.map((a: any) => ({ ...a, published: a.published ? new Date(a.published) : null })) };
        memCache.set(url, hit);
      }
    } catch {}
  }
  return hit && Date.now() - hit.at < CACHE_MS ? hit.data : null;
}
function cacheSet(url: string, data: Article[]) {
  const entry = { at: Date.now(), data };
  memCache.set(url, entry);
  try {
    // Drop stale entries so storage doesn't fill up.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith('ng:') && Date.now() - (JSON.parse(localStorage.getItem(k) ?? '{}').at ?? 0) > CACHE_MS) localStorage.removeItem(k);
    }
    localStorage.setItem('ng:' + url, JSON.stringify(entry));
  } catch {}
}

export function gdeltQueryString(q: NewsQuery): string {
  const terms = [...new Set(q.places.map(clean).filter((t) => t.length >= 3))].map((t) => `"${t}"`);
  const place = terms.length > 1 ? `(${terms.join(' OR ')})` : terms[0] ?? '';
  return [place, q.topic.gdelt, q.englishOnly ? 'sourcelang:english' : ''].filter(Boolean).join(' ');
}

function parseGdeltDate(s?: string): Date | null {
  // e.g. 20261118T094500Z
  const m = s?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

class RetryableError extends Error {}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gdeltOnce(url: string): Promise<Article[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), GDELT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    // A 429 without CORS headers, a timeout and a dropped connection all look like this.
    throw new RetryableError(ctrl.signal.aborted ? 'GDELT timed out' : 'GDELT is busy (rate limited or unreachable)');
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  if (res.status === 429 || /limit requests/i.test(text)) throw new RetryableError('GDELT is busy (rate limited)');
  if (!res.ok) throw new RetryableError(`GDELT responded ${res.status}`);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    // GDELT reports query problems as plain text; those won't improve on retry.
    throw new Error(text.trim().slice(0, 200) || 'GDELT returned an empty response');
  }
  const seen = new Set<string>();
  return (json.articles ?? [])
    .filter((a: any) => {
      // GDELT often lists the same story syndicated under identical titles.
      const k = (a.title ?? '').toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((a: any) => ({
      title: a.title,
      url: a.url,
      source: a.domain,
      published: parseGdeltDate(a.seendate),
      image: a.socialimage || undefined,
      language: a.language,
      country: a.sourcecountry,
    }));
}

export async function fetchGdelt(q: NewsQuery, onStatus?: (msg: string) => void): Promise<Article[]> {
  const params = new URLSearchParams({
    query: gdeltQueryString(q),
    mode: 'artlist',
    format: 'json',
    maxrecords: '100',
    timespan: q.timespan,
    sort: q.sort,
  });
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params}`;
  const hit = cacheGet(url);
  if (hit) return hit;

  return schedule(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await gdeltOnce(url);
        cacheSet(url, data);
        release();
        return data;
      } catch (e) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (!(e instanceof RetryableError) || delay === undefined || pending) {
          // Give up (or let a newer request go first).
          release(e instanceof RetryableError ? 4000 : 0);
          if (pending) throw new SupersededError();
          throw e;
        }
        onStatus?.(`${(e as Error).message}. Retrying in ${delay / 1000} s…`);
        await sleep(delay);
        if (pending) {
          release();
          throw new SupersededError();
        }
        onStatus?.('Scanning news feeds…');
      }
    }
  });
}

// ---------------------------------------------------------------------------
// The Guardian Open Platform — free developer key, high-quality English journalism.
// Enabled only when VITE_GUARDIAN_KEY is set at build time.
// ---------------------------------------------------------------------------
export const GUARDIAN_KEY: string | undefined = import.meta.env.VITE_GUARDIAN_KEY || undefined;

const SPAN_DAYS = { '24h': 1, '3d': 3, '1w': 7, '1m': 30 } as const;

export async function fetchGuardian(q: NewsQuery, signal?: AbortSignal): Promise<Article[]> {
  if (!GUARDIAN_KEY) throw new Error('No Guardian API key configured');
  const from = new Date(Date.now() - SPAN_DAYS[q.timespan] * 864e5).toISOString().slice(0, 10);
  const terms = [...new Set(q.places.map(clean).filter(Boolean))].map((t) => `"${t}"`);
  const params = new URLSearchParams({
    q: terms.join(' OR '),
    'from-date': from,
    'order-by': q.sort === 'datedesc' ? 'newest' : 'relevance',
    'show-fields': 'thumbnail,trailText',
    'page-size': '50',
    'api-key': GUARDIAN_KEY,
  });
  if (q.topic.guardian) params.set('section', q.topic.guardian);
  const res = await fetch(`https://content.guardianapis.com/search?${params}`, { signal });
  if (!res.ok) throw new Error(`Guardian responded ${res.status}`);
  const json = await res.json();
  return (json.response?.results ?? []).map((r: any) => ({
    title: r.webTitle,
    url: r.webUrl,
    source: `theguardian.com · ${r.sectionName}`,
    published: r.webPublicationDate ? new Date(r.webPublicationDate) : null,
    image: r.fields?.thumbnail,
    summary: r.fields?.trailText?.replace(/<[^>]+>/g, ''),
    language: 'English',
  }));
}
