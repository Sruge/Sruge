# NewsGlobe

A futuristic 3D globe for reading the news by place. Spin and zoom the planet; once you zoom in, the region
under the crosshair is "locked" and the latest articles published about it appear in the side panel. Filter
by topic, time window, sort order and language.

- **World view** (altitude ≥ 1.6): free rotation, hover a country to see its name, click it to fly there.
- **Country lock** (altitude < 1.6): news mentioning the country under the crosshair.
- **City / region lock** (altitude < 0.45): the point is reverse-geocoded and news mentioning the city or
  region is shown instead.

## Run it

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # static site in dist/
```

It is a pure static site (no backend), so it can be hosted anywhere. `.github/workflows/deploy.yml`
publishes it to GitHub Pages on every push to `main` (enable Pages → "GitHub Actions" in the repo settings).

## Stack

- [globe.gl](https://globe.gl) (three.js) — hex-dot land, glowing atmosphere, country outlines, scan rings
- [Natural Earth](https://www.naturalearthdata.com/) country shapes via `world-atlas`, `d3-geo` for hit-testing
- Vite + TypeScript, no framework

## News sources

The app uses **GDELT** by default because it is free, needs no key, covers the whole world in 65+ languages
and can be called directly from the browser. Other options, for comparison:

| Source | Cost / limits | Key | Good for |
|---|---|---|---|
| **[GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)** (used) | Free, ~1 request / 5 s, last 3 months | No | Global coverage, every country, themes (`theme:ELECTION`…), tone, source country/language |
| **[The Guardian Open Platform](https://open-platform.theguardian.com/)** (optional, built in) | Free dev key, 500 calls/day | Yes | High-quality English articles with summaries and images |
| [NewsData.io](https://newsdata.io/) | Free 200 credits/day | Yes | Country + category filters, many languages |
| [GNews](https://gnews.io/) | Free 100 requests/day | Yes | Simple search, country filter |
| [NewsAPI.org](https://newsapi.org/) | Free dev plan, **localhost only**, 24 h delay | Yes | Prototyping only — production needs a paid plan |
| [Currents API](https://currentsapi.services/) | Free 600 requests/day | Yes | Region + category filters |
| [New York Times APIs](https://developer.nytimes.com/) | Free, 500/day | Yes | NYT archive and top stories |
| RSS feeds (BBC, Reuters, Al Jazeera, local papers…) | Free | No | Needs a small server/proxy (no CORS) and your own geotagging |

To enable the Guardian toggle, copy `.env.example` to `.env` and set `VITE_GUARDIAN_KEY`. Note that any
`VITE_*` key is embedded in the built JavaScript and visible to visitors; for keys that must stay secret,
put a tiny proxy (e.g. a Cloudflare Worker) in front of the API.

City/region lookup uses [BigDataCloud's free client-side reverse geocoder](https://www.bigdatacloud.com/free-api/free-reverse-geocode-to-city-api) (no key).

## How a query is built

`src/news.ts` turns the locked place and the selected topic into a GDELT query such as

```
("Lyon" OR "Auvergne-Rhône-Alpes") (football OR soccer OR olympics …) sourcelang:english
```

Topic definitions live in `src/topics.ts` — edit them to add topics or tune what each one matches. Requests
are cached for 10 minutes and throttled to GDELT's one-per-5-seconds limit (a newer request replaces one that
is still waiting).

## Ideas for next steps

- Heat map of news volume per country (GDELT `mode=timelinevol` or the GDELT GEO/Events data)
- Article markers at exact coordinates using GDELT's event/GKG location data
- A small backend that aggregates several sources, dedupes stories and hides API keys
- Shareable URLs (`#lat,lng,alt,topic`)
