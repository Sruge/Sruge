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
// GDELT DOC 2.0 — free, keyless, global, ~15 min latency, 65+ languages.
// Docs: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
// GDELT asks clients to send at most one request every 5 seconds, so requests go
// through a single "latest wins" slot: a newer request replaces one still waiting.
// ---------------------------------------------------------------------------
const GDELT_GAP_MS = 5500;
let lastGdeltAt = 0;
let pending: { run: () => void; reject: (e: Error) => void } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const cache = new Map<string, { at: number; data: Article[] }>();
const CACHE_MS = 10 * 60 * 1000;

function schedule<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending?.reject(new SupersededError());
    pending = { run: () => task().then(resolve, reject), reject };
    clearTimeout(timer);
    const wait = Math.max(0, lastGdeltAt + GDELT_GAP_MS - Date.now());
    timer = setTimeout(() => {
      const job = pending;
      pending = null;
      lastGdeltAt = Date.now();
      job?.run();
    }, wait);
  });
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

export async function fetchGdelt(q: NewsQuery): Promise<Article[]> {
  const query = gdeltQueryString(q);
  const params = new URLSearchParams({
    query,
    mode: 'artlist',
    format: 'json',
    maxrecords: '75',
    timespan: q.timespan,
    sort: q.sort,
  });
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?${params}`;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  return schedule(async () => {
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) throw new Error(`GDELT responded ${res.status}`);
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      // GDELT reports query problems (and rate limiting) as plain text.
      throw new Error(text.trim().slice(0, 200) || 'GDELT returned an empty response');
    }
    const seen = new Set<string>();
    const data: Article[] = (json.articles ?? [])
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
    cache.set(url, { at: Date.now(), data });
    return data;
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
