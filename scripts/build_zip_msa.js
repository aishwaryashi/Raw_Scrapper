/**
 * scripts/build_zip_msa.js
 * One-time build script — generates data/zip_to_msa.json
 *
 * Strategy:
 *  1. Iterate all 00000-99999 ZIPs via zipcodes-us (in-memory, instant)
 *  2. Group by unique county+state — one representative lat/lng per county
 *  3. Query TIGERweb once per unique county (~1200 counties that are in an MSA)
 *     using 10-concurrent batches to stay within rate limits
 *  4. Write ZIP → MSA-name JSON to data/zip_to_msa.json
 *
 * Run once: node scripts/build_zip_msa.js
 * Expected runtime: 3-8 minutes depending on network speed.
 */

import { find as zipFind } from 'zipcodes-us';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = join(__dirname, '../data/zip_to_msa.json');

const CONCURRENCY = 10;          // parallel TIGERweb requests
// Layer 0 = Combined Statistical Areas — supports per-point spatial queries.
// Other MSA layers (1,7,13…) reject spatial queries.
const TIGERWEB_URL =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/CBSA/MapServer/0/query';

// ── Step 1: scan all ZIP codes via zipcodes-us (instant, no network) ──────────

console.log('[1/4] Scanning all valid US ZIP codes via zipcodes-us…');

const allZips = [];
for (let i = 0; i <= 99999; i++) {
  const zip = String(i).padStart(5, '0');
  const r = zipFind(zip);
  if (r && r.isValid && r.latitude && r.longitude) {
    allZips.push({ zip, lat: r.latitude, lng: r.longitude, county: r.county, stateCode: r.stateCode });
  }
}
console.log(`   → ${allZips.length} valid ZIP codes found.`);

// ── Step 2: group by county+state, one representative lat/lng per county ──────

console.log('[2/4] Grouping by unique county+state…');

const countyMap = {};   // "County|ST" → { lat, lng, zips[] }
for (const z of allZips) {
  const key = `${z.county}|${z.stateCode}`;
  if (!countyMap[key]) {
    countyMap[key] = { lat: z.lat, lng: z.lng, zips: [] };
  }
  countyMap[key].zips.push(z.zip);
}
const countyEntries = Object.entries(countyMap);
console.log(`   → ${countyEntries.length} unique counties.`);

// ── Step 3: query TIGERweb for each county ────────────────────────────────────

console.log(`[3/4] Querying TIGERweb for MSA name per county (concurrency=${CONCURRENCY})…`);

async function getMsaForCoords(lat, lng) {
  try {
    const url =
      TIGERWEB_URL +
      `?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326` +
      `&spatialRel=esriSpatialRelIntersects&outFields=NAME&returnGeometry=false&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const data = await res.json();
    const name = data?.features?.[0]?.attributes?.NAME;
    if (!name) return null;
    return name
      .replace(/,?\s*Metro(?:politan)?\s+(?:Statistical\s+)?(?:Area|Division)\b.*/i, '')
      .replace(/,?\s*Micro(?:politan)?\s+Statistical\s+Area\b.*/i, '')
      .replace(/,?\s*\bCSA\b.*/i, '')
      .trim();
  } catch {
    return null;
  }
}

// Process in batches
const countyToMsa = {};   // "County|ST" → msaName
let done = 0;
const total = countyEntries.length;

for (let i = 0; i < total; i += CONCURRENCY) {
  const batch = countyEntries.slice(i, i + CONCURRENCY);
  const results = await Promise.all(
    batch.map(([key, { lat, lng }]) =>
      getMsaForCoords(lat, lng).then(msa => ({ key, msa }))
    )
  );
  for (const { key, msa } of results) {
    if (msa) countyToMsa[key] = msa;
  }
  done += batch.length;
  if (done % 100 === 0 || done === total) {
    const msaCount = Object.keys(countyToMsa).length;
    process.stdout.write(`\r   ${done}/${total} counties processed — ${msaCount} mapped to an MSA`);
  }
}
console.log(`\n   → ${Object.keys(countyToMsa).length} counties are in an MSA.`);

// ── Step 4: build ZIP → MSA name map and write JSON ───────────────────────────

console.log('[4/4] Building ZIP → MSA map and writing JSON…');

const zipToMsa = {};
for (const { zip, county, stateCode } of allZips) {
  const key = `${county}|${stateCode}`;
  if (countyToMsa[key]) zipToMsa[zip] = countyToMsa[key];
}

const mappedCount = Object.keys(zipToMsa).length;
console.log(`   → ${mappedCount} ZIP codes mapped to an MSA.`);

writeFileSync(OUT_PATH, JSON.stringify(zipToMsa), 'utf8');
console.log(`\n✓ Written to ${OUT_PATH}`);

// Spot checks
const checks = ['07302', '07307', '28278', '77004', '10001', '90210', '60601'];
console.log('\nSpot checks:');
for (const z of checks) {
  console.log(`  ${z} → ${zipToMsa[z] ?? '(not in a metro area)'}`);
}
