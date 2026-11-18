import Globe from 'globe.gl';
import { BufferGeometry, Color, Float32BufferAttribute, LineBasicMaterial, LineSegments, MeshPhongMaterial } from 'three';
import './style.css';
import { BORDERS, COUNTRIES, COUNTRIES_COARSE, HEX_RES, countryAt, reverseGeocode, type Country } from './geo';
import { TOPICS } from './topics';
import { fetchGdelt, fetchGuardian, gdeltQueryString, GUARDIAN_KEY, SupersededError, type Article, type NewsQuery } from './news';

/** Below this camera altitude (in globe radii) a region is "locked" and its news loads. */
const LOCK_ALT = 1.6;
/** Below this altitude we refine from country to city/region. */
const CITY_ALT = 0.15;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  stage: $('stage'),
  globe: $('globe'),
  telemetry: $('telemetry'),
  kind: $('target-kind'),
  name: $('target-name'),
  status: $('status'),
  topics: $('topics'),
  timespan: $<HTMLSelectElement>('timespan'),
  sort: $<HTMLSelectElement>('sort'),
  english: $<HTMLInputElement>('english'),
  source: $<HTMLSelectElement>('source'),
  sourceWrap: $('source-wrap'),
  articles: $<HTMLOListElement>('articles'),
  panel: $('panel'),
  panelToggle: $('panel-toggle'),
  search: $<HTMLFormElement>('search'),
  searchInput: $<HTMLInputElement>('search-input'),
  countryList: $<HTMLDataListElement>('country-list'),
  hoverLabel: $('hover-label'),
};

interface Target {
  kind: 'COUNTRY' | 'CITY / REGION';
  label: string;
  places: string[];
  country: Country | null;
  lat: number;
  lng: number;
}

const state = {
  topic: TOPICS[0],
  target: null as Target | null,
  hovered: null as Country | null,
  lastKey: '',
};

// ---------------------------------------------------------------- globe ---
const CYAN = '63, 245, 255';
const MAGENTA = '255, 64, 200';

/** Only the hovered and the locked country are real polygons; everything else is one merged border mesh. */
function highlighted(): Country[] {
  return [...new Set([state.hovered, state.target?.country].filter((c): c is Country => !!c))];
}
const isTarget = (d: object) => d === state.target?.country;

const globe = new Globe(ui.globe, { animateIn: true })
  .backgroundColor('rgba(0,0,0,0)')
  .showAtmosphere(true)
  .atmosphereColor(`rgb(${CYAN})`)
  .atmosphereAltitude(0.2)
  .showGraticules(true)
  // Land as a field of glowing hex dots.
  .hexPolygonsData(COUNTRIES_COARSE)
  .hexPolygonResolution(HEX_RES)
  .hexPolygonMargin(0.4)
  .hexPolygonAltitude(0.006)
  .hexPolygonColor(() => `rgba(${CYAN}, 0.55)`)
  .polygonsData([])
  .polygonAltitude((d) => (isTarget(d) ? 0.012 : 0.009))
  .polygonCapColor((d) => (isTarget(d) ? `rgba(${MAGENTA}, 0.22)` : `rgba(${CYAN}, 0.14)`))
  .polygonSideColor(() => 'rgba(0,0,0,0)')
  .polygonStrokeColor((d) => (isTarget(d) ? `rgba(${MAGENTA}, 0.95)` : `rgba(${CYAN}, 0.8)`))
  .polygonCapCurvatureResolution(3)
  .polygonsTransitionDuration(0)
  .onGlobeClick(({ lat, lng }) => onPick(lat, lng))
  .onPolygonClick((_d, _e, { lat, lng }) => onPick(lat, lng))
  // Pulsing scan rings on the locked target.
  .ringsData([])
  .ringColor(() => (t: number) => `rgba(${MAGENTA}, ${1 - t})`)
  .ringMaxRadius(5)
  .ringPropagationSpeed(2.5)
  .ringRepeatPeriod(1100)
  .pointOfView({ lat: 25, lng: 10, altitude: 2.6 });

// Never render more pixels than needed; high-DPI phones otherwise draw 9× the pixels.
globe.renderer().setPixelRatio(Math.min(devicePixelRatio, 1.5));

const mat = globe.globeMaterial() as MeshPhongMaterial;
mat.color = new Color('#03101f');
mat.emissive = new Color('#021a2e');
mat.emissiveIntensity = 0.6;
mat.shininess = 12;

// All borders and coastlines in a single draw call.
{
  const pos: number[] = [];
  for (const line of BORDERS.coordinates) {
    for (let i = 1; i < line.length; i++) {
      for (const [lng, lat] of [line[i - 1], line[i]]) {
        const { x, y, z } = globe.getCoords(lat, lng, 0.007);
        pos.push(x, y, z);
      }
    }
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(pos, 3));
  globe.scene().add(new LineSegments(geom, new LineBasicMaterial({ color: `rgb(${CYAN})`, transparent: true, opacity: 0.35 })));
}

const controls = globe.controls();
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;
controls.minDistance = 101 + 8; // don't clip through the surface
controls.zoomSpeed = 0.8;
ui.globe.addEventListener('pointerdown', () => (controls.autoRotate = false), { once: true });
ui.globe.addEventListener('wheel', () => (controls.autoRotate = false), { once: true, passive: true });

function refreshPolygons() {
  globe.polygonsData(highlighted());
}

function onPick(lat: number, lng: number) {
  const c = countryAt(lat, lng);
  if (!c) return;
  const [clng, clat] = c.properties.centroid;
  flyTo(clat, clng, Math.min(1.0, globe.pointOfView().altitude));
}

// Hover: hit-test the pointer against country shapes (cheap with bounding boxes) instead of
// raycasting hundreds of meshes.
let hoverFrame = 0;
ui.globe.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || e.buttons) return;
  cancelAnimationFrame(hoverFrame);
  hoverFrame = requestAnimationFrame(() => {
    const r = ui.globe.getBoundingClientRect();
    const p = globe.toGlobeCoords(e.clientX - r.left, e.clientY - r.top);
    const c = p ? countryAt(p.lat, p.lng, false) : null;
    if (c) {
      ui.hoverLabel.textContent = c.properties.name;
      ui.hoverLabel.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
    }
    ui.hoverLabel.hidden = !c;
    ui.globe.style.cursor = c ? 'pointer' : '';
    if (c !== state.hovered) {
      state.hovered = c;
      refreshPolygons();
    }
  });
});
ui.globe.addEventListener('pointerleave', () => {
  ui.hoverLabel.hidden = true;
  state.hovered = null;
  refreshPolygons();
});

function flyTo(lat: number, lng: number, altitude: number) {
  controls.autoRotate = false;
  globe.pointOfView({ lat, lng, altitude }, 1400);
  setTimeout(evaluateView, 1500);
}

function resize() {
  globe.width(ui.stage.clientWidth).height(ui.stage.clientHeight);
}
new ResizeObserver(resize).observe(ui.stage);
resize();

// ------------------------------------------------------------ view loop ---
controls.addEventListener('change', () => {
  const { lat, lng, altitude } = globe.pointOfView();
  ui.telemetry.textContent = `LAT ${lat.toFixed(2)} · LNG ${lng.toFixed(2)} · ALT ${altitude.toFixed(2)}`;
  document.body.classList.toggle('locked', altitude < LOCK_ALT);
});

let viewTimer: ReturnType<typeof setTimeout> | undefined;
const scheduleEvaluate = () => {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(evaluateView, 650);
};
controls.addEventListener('end', scheduleEvaluate);
globe.onZoom(scheduleEvaluate);

let geoAbort: AbortController | undefined;

async function evaluateView() {
  const { lat, lng, altitude } = globe.pointOfView();
  if (altitude >= LOCK_ALT) {
    setTarget(null);
    return;
  }
  const country = countryAt(lat, lng);
  let target: Target | null = country
    ? { kind: 'COUNTRY', label: country.properties.name, places: country.properties.aliases, country, lat, lng }
    : null;

  if (altitude < CITY_ALT) {
    geoAbort?.abort();
    geoAbort = new AbortController();
    try {
      const loc = await reverseGeocode(lat, lng, geoAbort.signal);
      if (loc && (loc.city || loc.region)) {
        const places = [loc.city, loc.region].filter((x): x is string => !!x);
        target = {
          kind: 'CITY / REGION',
          label: [loc.city, loc.region, loc.country].filter(Boolean).join(', '),
          places,
          country,
          lat,
          lng,
        };
      }
    } catch {
      return; // aborted by a newer view change
    }
  }
  setTarget(target);
}

function setTarget(t: Target | null) {
  const prev = state.target;
  state.target = t;
  if (prev?.country !== t?.country) refreshPolygons();
  globe.ringsData(t ? [{ lat: t.lat, lng: t.lng }] : []);
  if (!t) {
    state.lastKey = '';
    ui.kind.textContent = 'NO TARGET';
    ui.name.textContent = 'Zoom in on a region';
    ui.status.textContent = 'Scroll or pinch to zoom · click a country to fly there';
    ui.articles.innerHTML = '';
    return;
  }
  loadNews();
}

// ----------------------------------------------------------------- news ---
function currentQuery(): NewsQuery | null {
  const t = state.target;
  if (!t) return null;
  return {
    places: t.places,
    topic: state.topic,
    timespan: ui.timespan.value as NewsQuery['timespan'],
    sort: ui.sort.value as NewsQuery['sort'],
    englishOnly: ui.english.checked,
  };
}

async function loadNews() {
  const q = currentQuery();
  const t = state.target;
  if (!q || !t) return;
  const source = ui.source.value;
  const key = JSON.stringify([q.places, q.topic.id, q.timespan, q.sort, q.englishOnly, source]);
  if (key === state.lastKey) return;
  state.lastKey = key;

  ui.kind.textContent = `TARGET LOCKED · ${t.kind}`;
  ui.name.textContent = t.label;
  ui.status.textContent = 'Scanning news feeds…';
  ui.articles.innerHTML = '<li class="skeleton"></li>'.repeat(5);

  try {
    const onStatus = (m: string) => key === state.lastKey && (ui.status.textContent = m);
    const slowHint = setTimeout(() => onStatus('Scanning news feeds… GDELT can take 10–20 s'), 4000);
    const articles = await (source === 'guardian' ? fetchGuardian(q) : fetchGdelt(q, onStatus)).finally(() =>
      clearTimeout(slowHint),
    );
    if (key !== state.lastKey) return;
    renderArticles(articles);
    if (t.kind === 'CITY / REGION' && t.country && articles.length < 10) {
      const c = t.country;
      ui.articles.insertAdjacentHTML(
        'beforeend',
        `<li class="empty"><button class="retry widen">Show all news about ${escapeHtml(c.properties.name)}</button></li>`,
      );
      ui.articles.querySelector('.widen')?.addEventListener('click', () => {
        const [lng, lat] = c.properties.centroid;
        flyTo(lat, lng, 1.0);
      });
    }
    ui.status.textContent = `${articles.length} article${articles.length === 1 ? '' : 's'} · ${q.topic.label} · ${ui.timespan.selectedOptions[0].text}`;
    ui.status.title = source === 'gdelt' ? `GDELT query: ${gdeltQueryString(q)}` : '';
  } catch (e) {
    if (e instanceof SupersededError || key !== state.lastKey) return;
    state.lastKey = ''; // allow retry
    ui.articles.innerHTML = '';
    ui.status.innerHTML = `Signal lost: ${escapeHtml((e as Error).message)} <button class="retry">Retry</button>`;
    ui.status.querySelector('button')?.addEventListener('click', loadNews);
  }
}

function renderArticles(list: Article[]) {
  if (!list.length) {
    ui.articles.innerHTML = '<li class="empty">No recent coverage found. Try another topic, a wider time window, or turn off “English only”.</li>';
    return;
  }
  ui.articles.innerHTML = list
    .map(
      (a) => `
      <li class="article">
        <a href="${escapeAttr(a.url)}" target="_blank" rel="noopener noreferrer">
          ${a.image ? `<img src="${escapeAttr(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ''}
          <div class="body">
            <h3>${escapeHtml(a.title)}</h3>
            ${a.summary ? `<p>${escapeHtml(a.summary)}</p>` : ''}
            <div class="meta mono">
              <span>${escapeHtml(a.source)}</span>
              ${a.published ? `<span title="${a.published.toLocaleString()}">${timeAgo(a.published)}</span>` : ''}
              ${a.language && a.language !== 'English' ? `<span>${escapeHtml(a.language)}</span>` : ''}
            </div>
          </div>
        </a>
      </li>`,
    )
    .join('');
}

// ------------------------------------------------------------- controls ---
ui.topics.innerHTML = TOPICS.map(
  (t, i) => `<button type="button" class="chip" data-id="${t.id}" aria-pressed="${i === 0}">${t.label}</button>`,
).join('');
ui.topics.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.chip');
  if (!btn) return;
  state.topic = TOPICS.find((t) => t.id === btn.dataset.id) ?? TOPICS[0];
  ui.topics.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === btn)));
  loadNews();
});
[ui.timespan, ui.sort, ui.english, ui.source].forEach((el) => el.addEventListener('change', loadNews));

if (GUARDIAN_KEY) ui.sourceWrap.hidden = false;

ui.panelToggle.addEventListener('click', () => {
  const collapsed = ui.panel.classList.toggle('collapsed');
  document.body.classList.toggle('sheet-collapsed', collapsed);
});

const byName = new Map(COUNTRIES.map((c) => [c.properties.name.toLowerCase(), c]));
ui.countryList.innerHTML = [...COUNTRIES]
  .sort((a, b) => a.properties.name.localeCompare(b.properties.name))
  .map((c) => `<option value="${escapeHtml(c.properties.name)}"></option>`)
  .join('');
ui.search.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = ui.searchInput.value.trim().toLowerCase();
  const c = byName.get(v) ?? COUNTRIES.find((x) => x.properties.name.toLowerCase().startsWith(v));
  if (!c) return;
  const [lng, lat] = c.properties.centroid;
  flyTo(lat, lng, 1.0);
  ui.searchInput.blur();
});
ui.searchInput.addEventListener('change', () => ui.search.requestSubmit());

// ---------------------------------------------------------------- stars ---
(function stars() {
  const canvas = document.createElement('canvas');
  const dpr = Math.min(devicePixelRatio, 2);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  const ctx = canvas.getContext('2d')!;
  for (let i = 0; i < 500; i++) {
    const r = Math.random() * 1.1 * dpr;
    ctx.fillStyle = `rgba(200, 235, 255, ${0.2 + Math.random() * 0.6})`;
    ctx.beginPath();
    ctx.arc(Math.random() * canvas.width, Math.random() * canvas.height, r, 0, Math.PI * 2);
    ctx.fill();
  }
  $('stars').style.backgroundImage = `url(${canvas.toDataURL()})`;
})();

// ---------------------------------------------------------------- utils ---
function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function escapeAttr(s: string) /* URLs only */ {
  return /^https?:\/\//i.test(s) ? escapeHtml(s) : '#';
}
function timeAgo(d: Date) {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
