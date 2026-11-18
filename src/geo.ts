import { feature } from 'topojson-client';
import { geoArea, geoCentroid, geoContains, geoDistance } from 'd3-geo';
import type { Feature, FeatureCollection, Geometry, Polygon } from 'geojson';
import { polygonToCells } from 'h3-js';
import countries50 from 'world-atlas/countries-50m.json';
import countries110 from 'world-atlas/countries-110m.json';

export interface CountryProps {
  name: string;
  /** Name(s) to search for in news text. */
  aliases: string[];
  centroid: [number, number]; // [lng, lat]
}
export type Country = Feature<Geometry, CountryProps>;

/** Natural Earth uses abbreviated names in places; map them to how the news writes them. */
const ALIASES: Record<string, string[]> = {
  'United States of America': ['United States'],
  'Dem. Rep. Congo': ['Congo', 'Kinshasa'],
  Congo: ['Congo', 'Brazzaville'],
  'Central African Rep.': ['Central African Republic'],
  'Bosnia and Herz.': ['Bosnia'],
  'S. Sudan': ['South Sudan'],
  'Eq. Guinea': ['Equatorial Guinea'],
  'W. Sahara': ['Western Sahara'],
  'Dominican Rep.': ['Dominican Republic'],
  'Solomon Is.': ['Solomon Islands'],
  'Falkland Is.': ['Falkland Islands'],
  'Fr. S. Antarctic Lands': ['French Southern Territories'],
  'N. Cyprus': ['Northern Cyprus'],
  eSwatini: ['Eswatini', 'Swaziland'],
  Macedonia: ['North Macedonia'],
  "Côte d'Ivoire": ['Ivory Coast', 'Cote dIvoire'],
  'Timor-Leste': ['East Timor', 'Timor-Leste'],
  Czechia: ['Czech Republic', 'Czechia'],
  'United Kingdom': ['United Kingdom', 'Britain'],
  'South Korea': ['South Korea', 'Seoul'],
  'North Korea': ['North Korea', 'Pyongyang'],
  Palestine: ['Palestine', 'Gaza', 'West Bank'],
};

/** Centroid of the largest landmass, so e.g. France isn't pulled toward French Guiana. */
function mainCentroid(f: Feature<Geometry>): [number, number] {
  if (f.geometry.type !== 'MultiPolygon') return geoCentroid(f) as [number, number];
  let best: Polygon | null = null;
  let bestA = -1;
  for (const coordinates of f.geometry.coordinates) {
    const poly: Polygon = { type: 'Polygon', coordinates };
    const a = geoArea(poly);
    if (a > bestA) [best, bestA] = [poly, a];
  }
  return geoCentroid(best!) as [number, number];
}

function toCountries(topo: any): Country[] {
  const fc = feature(topo, topo.objects.countries) as unknown as FeatureCollection<Geometry, { name: string }>;
  return fc.features
    .filter((f) => f.properties?.name && f.properties.name !== 'Antarctica')
    .map((f) => {
      const name = f.properties.name;
      return {
        ...f,
        properties: {
          name,
          aliases: ALIASES[name] ?? [name],
          centroid: mainCentroid(f),
        },
      };
    });
}

/** Detailed shapes: borders, hover and hit-testing. */
export const COUNTRIES = toCountries(countries50);
/** Hex resolution used by the land-dot layer. */
export const HEX_RES = 3;

/** h3 throws on a few degenerate shapes, which would abort the whole hex layer. */
function hexable(f: Country): boolean {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  try {
    polys.forEach((p) => polygonToCells(p, HEX_RES, true));
    return true;
  } catch {
    return false;
  }
}

/** Coarse shapes for the hex-dot land layer (cheaper to tessellate), falling back to detailed ones. */
export const COUNTRIES_COARSE = toCountries(countries110)
  .map((c) => (hexable(c) ? c : COUNTRIES.find((d) => d.properties.name === c.properties.name && hexable(d))))
  .filter((c): c is Country => !!c);

/** Country under a point, or the nearest one within ~600 km (useful over coasts and small islands). */
export function countryAt(lat: number, lng: number): Country | null {
  const p: [number, number] = [lng, lat];
  const hit = COUNTRIES.find((c) => geoContains(c, p));
  if (hit) return hit;
  let best: Country | null = null;
  let bestD = Infinity;
  for (const c of COUNTRIES) {
    const d = geoDistance(p, c.properties.centroid);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD < 0.1 ? best : null; // radians; 0.1 ≈ 640 km
}

export interface Locality {
  city?: string;
  region?: string;
  country?: string;
}

const localityCache = new Map<string, Locality | null>();

/**
 * City/region under a point via BigDataCloud's free client-side reverse geocoder (no key, CORS enabled).
 * Rounded to ~10 km so panning around a city doesn't spam requests.
 */
export async function reverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<Locality | null> {
  const key = `${lat.toFixed(1)},${lng.toFixed(1)}`;
  if (localityCache.has(key)) return localityCache.get(key)!;
  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    const loc: Locality = {
      city: j.city || j.locality || undefined,
      region: j.principalSubdivision || undefined,
      country: j.countryName || undefined,
    };
    localityCache.set(key, loc);
    return loc;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    localityCache.set(key, null);
    return null;
  }
}
