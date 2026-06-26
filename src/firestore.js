/**
 * firestore.js
 * Firebase Admin SDK wrapper for saving scraped ads to Firestore.
 *
 * Collection: `ads`
 * Document ID: adId (string)
 * Dedup: checks whether the document already exists before writing.
 * Fixed user: the Urjaonly account as specified in actor input.
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { log } from 'crawlee';

const ADS_COLLECTION = 'ads';
const PROJECT_ID = 'rentalportal-494212';

const FIXED_USER = {
  business: null,
  displayName: 'Urjaonly',
  email: 'urjaonly@gmail.com',
  isVerified: true,
  phone: '+917309022755',
  role: 'I am the property owner',
  uid: '6gktdvJsapcUKvJVVCT5j1sN3Ct2',
};

let db = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Detect whether an object is a Firebase Service Account JSON
 * (has `type: "service_account"` and `private_key`) vs the
 * web client config (has `apiKey`).
 */
function isServiceAccount(obj) {
  return obj && obj.type === 'service_account' && typeof obj.private_key === 'string';
}

/**
 * Initialize Firebase Admin SDK.
 *
 * Accepts TWO forms of credential via the `credential` parameter:
 *
 *  1. Service Account JSON  (recommended)
 *     Download from: Firebase Console → Project Settings →
 *     Service Accounts → Generate new private key
 *     This is a JSON object with keys: type, project_id, private_key, client_email …
 *
 *  2. Web client config  (alternative — the object shown in Firebase Console →
 *     Project Settings → General → Your apps → npm config snippet)
 *     Recognised by the presence of `apiKey`.  In this mode the SDK is
 *     initialised with just the projectId; Firestore security rules must
 *     permit the writes.
 *
 * @param {object|string} credential - Service Account JSON or Web config object/string.
 */
export function initFirestore(credential) {
  if (db) return db;

  const cred = typeof credential === 'string' ? JSON.parse(credential) : credential;

  if (!getApps().length) {
    if (isServiceAccount(cred)) {
      // ── Mode 1: Service Account JSON (full admin access) ──────────────────
      initializeApp({ credential: cert(cred) });
      log.info('[FIRESTORE] Initialized with Service Account (admin access).');
    } else if (cred && cred.apiKey && cred.projectId) {
      // ── Mode 2: Web client config (projectId-only init) ───────────────────
      // Admin SDK is initialized with only the projectId.
      // Requires GOOGLE_APPLICATION_CREDENTIALS env var OR Apify env.
      // Firestore security rules must allow the intended writes.
      initializeApp({ projectId: cred.projectId || PROJECT_ID });
      log.info(`[FIRESTORE] Initialized with web config (projectId: ${cred.projectId}).`);
      log.warning(
        '[FIRESTORE] Web config mode: ensure GOOGLE_APPLICATION_CREDENTIALS is set, ' +
        'OR get a Service Account key from Firebase Console → Project Settings → Service Accounts.'
      );
    } else {
      // ── Mode 3: Fallback — use hard-coded projectId (needs env ADC) ───────
      initializeApp({ projectId: PROJECT_ID });
      log.warning('[FIRESTORE] No valid credential provided — falling back to projectId-only init. ' +
        'Set GOOGLE_APPLICATION_CREDENTIALS or provide a Service Account JSON.');
    }
  }

  db = getFirestore();
  return db;
}

export function isFirestoreReady() {
  return db !== null;
}

// ─── Document builder ─────────────────────────────────────────────────────────

/**
 * Convert "not_found" placeholder and undefined to null (Firestore-safe).
 */
function n(v) {
  if (v === undefined || v === null || v === 'not_found') return null;
  return v;
}

// ─── SCRAPPED_AD_DETAILS parsers ──────────────────────────────────────────────

/** "3 Baths" | "1 Bath" → 3 | 1 */
function parseBathsNum(str) {
  if (str == null) return null;
  const m = String(str).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** "4 Beds" | "4+ Beds" | "Studio" → 4 | 4 | 0 */
function parseBedsNum(str) {
  if (str == null) return null;
  if (/studio/i.test(String(str))) return 0;
  const m = String(str).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * "$850 /Month" | "₹15,000/month" → { amount, currency, mode }
 * Handles $, ₹, £, € and per-week / per-day / per-year variants.
 */
function parseRentStr(str) {
  if (!str) return null;
  const s = String(str);
  const currency = s.includes('₹') ? 'INR'
    : s.includes('£') ? 'GBP'
    : s.includes('€') ? 'EUR'
    : 'USD';
  const numMatch = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!numMatch) return null;
  const amount = parseFloat(numMatch[1]);
  const mode = /week/i.test(s) ? 'per_week'
    : /day/i.test(s)  ? 'per_day'
    : /year/i.test(s) ? 'per_year'
    : 'per_month';
  return { amount, currency, mode };
}

/** "3500 sqft" | "3,500 sq ft" → 3500 */
function parseAreaNum(str) {
  if (str == null) return null;
  const m = String(str).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Map a raw propertyCategory label (from SCRAPPED_AD_DETAILS or JSON) to a
 * canonical propertyType value.  Matching is case-insensitive and tolerates
 * extra whitespace.  Returns null when no match is found.
 */
const PROPERTY_TYPE_MAP = {
  'single family home': 'single_family_home',
  'apartment':          'apartment',
  'condo':              'condo',
  'town house':         'townhouse',
  'townhouse':          'townhouse',
  'homes':              'homes',
  'home':               'homes',
  'houses':             'houses',
  'house':              'houses',
  'shared room':        'shared_room',
  'single room':        'single_room',
  'paying guest':       'paying_guest',
};

function normalizePropertyType(raw) {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  return PROPERTY_TYPE_MAP[key] || null;
}

/**
 * Parse "May 31, 2026" / "Jun 05, 2026" (SCRAPPED_AD_DETAILS.postedOn) into a
 * Firestore Timestamp.  Returns null on any parse failure.
 */
function parsePostedOnTimestamp(str) {
  if (!str || typeof str !== 'string') return null;
  const d = new Date(str.trim());
  if (isNaN(d.getTime())) return null;
  return Timestamp.fromDate(d);
}

/** Return a Firestore Timestamp exactly one year after the given Timestamp. */
function addOneYear(ts) {
  if (!ts) return null;
  const d = ts.toDate();
  d.setFullYear(d.getFullYear() + 1);
  return Timestamp.fromDate(d);
}

/** Format a Firestore Timestamp as "YYYY-MM-DD". */
function toDateStr(ts) {
  if (!ts) return null;
  const d = ts.toDate();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Preference option lists ────────────────────────────────────────────────────

const LANGUAGE_OPTIONS   = ["English","Hindi","Tamil","Telugu","Malayalam","Gujarati","Bengali","Kannada","Urdu","Manipuri","Marathi","Nepali","Oriya","Punjabi","Sanskrit","Sindhi","Santhali","Maithili","Dogri","Assamese","Konkani","Kashmiri","Other"];
const AGE_RANGE_OPTIONS  = ["18 to 99 (Any)","18 to 25","18 to 50","25 to 45","40 to 55","55 to 70","70 plus"];
const GENDER_OPTIONS     = ["Male","Female","Any"];
const OCCUPATION_OPTIONS = ["Students only allowed","Professionals only allowed","Don't mind/No preference","Others"];
const PETS_OPTIONS       = ["No Pets","Only Dogs","Only Cats","Any Pet is Ok"];
const SMOKING_OPTIONS    = ["No Smoking","Smoking is Ok","Smoke outside only"];
const VEGETARIAN_OPTIONS = ["Yes, Vegetarian mandatory","No, Non-veg is ok","Both"];

/**
 * Case-insensitive match against an allowed options list.
 * Tries exact match first, then checks whether the raw value contains an option
 * or an option contains the raw value.  Returns the canonical option or null.
 */
function matchOption(raw, options) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const exact = options.find(o => o.toLowerCase() === s);
  if (exact) return exact;
  const sub = options.find(o => s.includes(o.toLowerCase()) || o.toLowerCase().includes(s));
  return sub || null;
}

/**
 * Convert an alcohol-related scraped string to a boolean.
 * "allowed" / "ok" / "yes" → true;  "not allowed" / "no" / "prohibit" → false.
 */
function normalizeAlcohol(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase();
  if (/not?\s+allow|no\s+alc|prohibit|not\s+ok/i.test(s)) return false;
  if (/allow|is\s+ok|\bok\b|yes|permit/i.test(s)) return true;
  return null;
}

/**
 * Normalise a languages value (array, object, or string) against LANGUAGE_OPTIONS.
 * Returns an array of canonical language strings.
 */
function normalizeLanguages(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map(r => matchOption(r, LANGUAGE_OPTIONS)).filter(Boolean);
  }
  if (typeof raw === 'object') {
    return Object.keys(raw)
      .filter(k => raw[k])
      .map(k => matchOption(k, LANGUAGE_OPTIONS))
      .filter(Boolean);
  }
  if (typeof raw === 'string') {
    const m = matchOption(raw, LANGUAGE_OPTIONS);
    return m ? [m] : [];
  }
  return [];
}

/**
 * Scan a text block for common rent-disclosure patterns and return
 * the first matched dollar string (suitable for passing to parseRentStr).
 *
 * Handles:
 *   "Rent: $1900"
 *   "EXPECTED RENT\n$2,100 /Month"
 *   "$2000 Per Month"  (often in titles)
 */
function extractRentFromText(text) {
  if (!text || typeof text !== 'string') return null;

  // "EXPECTED RENT" label followed by amount on the next line
  const expM = text.match(/expected\s+rent[:\s]*\r?\n\s*(\$[\d,]+(?:\.\d+)?(?:\s*\/\s*\w+)?)/i);
  if (expM) return expM[1];

  // "Rent: $1900" or "Rent $1900" inline label
  const rentLabelM = text.match(/\brent[:\s]+\*?\s*(\$[\d,]+(?:\.\d+)?(?:\s*\/?\s*(?:month|mo\.?|week|day|year|yr))?)/i);
  if (rentLabelM) return rentLabelM[1];

  // "$2000 Per Month" or "$2000/month" pattern
  const perMonthM = text.match(/(\$[\d,]+(?:\.\d+)?)(?:\s*(?:per|\/)\s*month|\s*\/\s*mo\.?)/i);
  if (perMonthM) return `${perMonthM[1]} /Month`;

  return null;
}

/**
 * Scan the amenities key-value object and derive structured values.
 *
 * Examples of keys produced by extractAmenities():
 *   "ad_typeproperty_offered"  → intent = "list"
 *   "ad_typeproperty_wanted"   → intent = "find"
 *   "area3500_sqft"            → squareFeet = 3500
 *   "bedrooms_4+_beds"         → beds = 4
 *   "available_from31_may_2026"→ availableFrom = "2026-05-31"
 */
function extractFromAmenityKeys(amenities) {
  if (!amenities || typeof amenities !== 'object' || Array.isArray(amenities)) return {};
  const result = {};
  const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

  for (const key of Object.keys(amenities)) {
    if (!amenities[key]) continue;

    // Intent
    if (/^ad_type.*offered/i.test(key))  { result.intent = 'list'; continue; }
    if (/^ad_type.*wanted/i.test(key))   { result.intent = 'find'; continue; }

    // Area: "area3500_sqft" → 3500
    const areaM = key.match(/^area(\d+(?:\.\d+)?)_sqft$/i);
    if (areaM) { result.squareFeet = parseFloat(areaM[1]); continue; }

    // Beds: "bedrooms_4+_beds" | "bedrooms_2_beds" → 4 | 2
    const bedsM = key.match(/^bedrooms?[_\s](\d+)/i);
    if (bedsM) { result.beds = parseInt(bedsM[1], 10); continue; }

    // Available from: "available_from31_may_2026" → "2026-05-31"
    const dateM = key.match(/^available_from(\d{1,2})_([a-z]+)_(\d{4})$/i);
    if (dateM) {
      const day   = parseInt(dateM[1], 10);
      const month = MONTHS[dateM[2].toLowerCase().slice(0, 3)];
      const year  = parseInt(dateM[3], 10);
      if (day && month && year) {
        result.availableFrom =
          `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  }
  return result;
}

/**
 * Build the top-level amenities key-value object that goes into Firestore.
 * Merges deep-scraped amenities + SCRAPPED_AD_DETAILS amenities array.
 */
function buildAmenitiesMap(adData) {
  const map = {};

  // 1. From extractAmenities() — already key:bool format
  const deepAmenities = adData.amenities;
  if (deepAmenities && typeof deepAmenities === 'object' && !Array.isArray(deepAmenities)) {
    Object.assign(map, deepAmenities);
  }

  // 2. From SCRAPPED_AD_DETAILS.amenities — array of DOM strings
  const scrAmenities = adData.SCRAPPED_AD_DETAILS?.amenities;
  if (Array.isArray(scrAmenities)) {
    for (const item of scrAmenities) {
      if (typeof item === 'string' && item.trim()) {
        // Normalise: lowercase, collapse whitespace → underscores, strip punctuation
        const key = item.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (key) map[key] = true;
      }
    }
  }

  return map;
}

// ─── US Metro Area via TIGERweb ──────────────────────────────────────────────
// Mirrors the exact same two-strategy approach used in the frontend metroArea.js
// so the stored metroArea value is identical regardless of whether an ad was
// posted through the app or scraped by this actor.

async function fetchUsMetroAreaByLatLng(lat, lng) {
  if (lat == null || lng == null) return null;

  const geomJson = JSON.stringify({
    x: lng, y: lat, spatialReference: { wkid: 4326 },
  });

  // Strategy A – query CBSA MapServer layers 0-3
  const CBSA = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/CBSA/MapServer';

  for (let layerId = 0; layerId <= 3; layerId++) {
    try {
      const url = new URL(`${CBSA}/${layerId}/query`);
      url.searchParams.set('geometry', geomJson);
      url.searchParams.set('geometryType', 'esriGeometryPoint');
      url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
      url.searchParams.set('outFields', 'NAME,LSAD,GEOID');
      url.searchParams.set('returnGeometry', 'false');
      url.searchParams.set('f', 'json');

      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(url.toString(), { signal: ctrl.signal });
      clearTimeout(tid);

      const data = await res.json();
      if (data?.error) { log.debug(`[FIRESTORE] TIGERweb layer ${layerId} error:`, data.error); continue; }

      const name = data?.features?.[0]?.attributes?.NAME;
      if (name) {
        log.info(`[FIRESTORE] TIGERweb CBSA layer ${layerId} → "${name}"`);
        return String(name).trim();
      }
    } catch (e) {
      log.debug(`[FIRESTORE] TIGERweb CBSA layer ${layerId} failed: ${e?.message ?? e}`);
    }
  }

  // Strategy B – tigerWMS_Current identify (all layers at once)
  try {
    const delta = 0.3;
    const url = new URL(
      'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/identify',
    );
    url.searchParams.set('f', 'json');
    url.searchParams.set('geometry', geomJson);
    url.searchParams.set('geometryType', 'esriGeometryPoint');
    url.searchParams.set('sr', '4326');
    url.searchParams.set('layers', 'all');
    url.searchParams.set('tolerance', '0');
    url.searchParams.set('mapExtent', `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`);
    url.searchParams.set('imageDisplay', '400,400,96');
    url.searchParams.set('returnGeometry', 'false');

    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    clearTimeout(tid);

    const data = await res.json();
    const msaResult = (data?.results ?? []).find((r) =>
      /metropolitan statistical|micropolitan statistical|core based statistical/i.test(r.layerName ?? ''),
    );
    if (msaResult) {
      const name = msaResult.attributes?.NAME ?? msaResult.value;
      if (name) {
        log.info(`[FIRESTORE] TIGERweb identify → "${name}"`);
        return String(name).trim();
      }
    }
  } catch (e) {
    log.debug(`[FIRESTORE] TIGERweb identify failed: ${e?.message ?? e}`);
  }

  log.warning(`[FIRESTORE] TIGERweb: no MSA found for lat=${lat} lng=${lng}`);
  return null;
}

/**
 * Transform the scraped adData object into the Firestore document structure.
 */
async function buildFirestoreDoc(adData) {
  const prop  = adData.property     || {};
  const loc   = adData.location     || {};
  const meta  = adData.metadata     || {};
  const pay   = adData.payment      || {};
  const priv  = adData.privacy      || {};
  const prefs = adData.preferences  || {};
  const avail = adData.availability || {};
  const scr   = adData.SCRAPPED_AD_DETAILS || {};   // DOM-scraped detail fields

  // ── SCRAPPED_AD_DETAILS: parse string values into numbers ─────────────────
  const scrRent  = parseRentStr(scr.rent);
  const scrBaths = parseBathsNum(scr.bathrooms);
  const scrBeds  = parseBedsNum(scr.bedrooms);
  const scrArea  = parseAreaNum(scr.areaSqft);

  // prop.rentAmount may arrive as a raw string like "$1,000 /Month" from the
  // JSON extractor — parse it into a numeric amount so Firestore always gets a number.
  const propRentRaw    = n(prop.rentAmount);
  const propRentParsed = typeof propRentRaw === 'string' ? parseRentStr(propRentRaw) : null;
  const propRentAmount = typeof propRentRaw === 'number'
    ? propRentRaw
    : (propRentParsed?.amount ?? null);

  // When scr.rent is "Contact for price" (no number), fall back to scanning
  // the description text and title for patterns like "Rent: $1900" or "$2,100 /Month".
  const descText = n(adData.description?.fullDescription) || n(scr.description) || null;
  const titleText = n(prop.title) || '';
  const rentFromText = parseRentStr(
    extractRentFromText(descText) || extractRentFromText(titleText)
  );

  // ── Amenity map + derived values ──────────────────────────────────────────
  const amenities  = buildAmenitiesMap(adData);
  const fromKeys   = extractFromAmenityKeys(amenities);

  // ── Effective (merged) scalar values ─────────────────────────────────────────
  // squareFeet: amenity key (e.g. "area1100_sqft") wins — it's the value the
  // poster explicitly entered in the Sulekha form and is the most reliable source.
  const effectiveBaths    = n(prop.baths)      ?? scrBaths   ?? null;
  const effectiveBeds     = n(prop.beds)        ?? scrBeds    ?? fromKeys.beds ?? null;
  const effectiveRent     = propRentAmount      ?? scrRent?.amount    ?? rentFromText?.amount    ?? null;
  const effectiveCurrency = propRentParsed?.currency || n(prop.rentCurrency) || scrRent?.currency || rentFromText?.currency || 'USD';
  const effectiveMode     = propRentParsed?.mode     || n(prop.rentFrequency) || scrRent?.mode   || rentFromText?.mode     || 'per_month';
  const effectiveSqFt       = fromKeys.squareFeet ?? scrArea ?? n(prop.squareFeet) ?? null;
  // SCRAPPED_AD_DETAILS.propertyCategory wins — it's the label the poster selected in the form.
  // Fall back to the JSON prop.propertyType if no match is found.
  const effectivePropertyType =
    normalizePropertyType(scr.propertyCategory) ||
    normalizePropertyType(n(prop.propertyType)) ||
    n(prop.propertyType) ||
    null;
  // Intent: amenity key wins when present; else metadata; else "list"
  const effectiveIntent    = fromKeys.intent || n(meta.intent) || 'list';
  // Available-from: amenity key (ISO "YYYY-MM-DD") wins — most reliable source.
  const effectiveAvailFrom = fromKeys.availableFrom || n(avail.availableFrom) || n(scr.availableFrom) || null;

  // ── Dates derived from SCRAPPED_AD_DETAILS.postedOn ──────────────────────
  // createdAt → Firestore Timestamp; adactivedate / adexpirydate → "YYYY-MM-DD".
  const activeTimestamp  = parsePostedOnTimestamp(scr.postedOn);
  const expiryTimestamp  = addOneYear(activeTimestamp);
  const activeDateStr    = toDateStr(activeTimestamp);
  const expiryDateStr    = toDateStr(expiryTimestamp);

  // ── Metro area: TIGERweb for US, scraped value for all others ────────────
  // The Sulekha-scraped loc.metroArea value (e.g. "Phoenix-Mesa-AZ") differs
  // from what the frontend app stores via TIGERweb ("Phoenix-Mesa-Chandler, AZ").
  // For US ads we call the same Census Bureau ArcGIS endpoint so the stored
  // text always matches what the homepage metro-area filter expects.
  let effectiveMetroArea = n(loc.metroArea) || '';
  if ((n(loc.countryCode) || '').toUpperCase() === 'US') {
    const lat = typeof n(loc.latitude)  === 'number' ? n(loc.latitude)  : null;
    const lng = typeof n(loc.longitude) === 'number' ? n(loc.longitude) : null;
    if (lat != null && lng != null) {
      try {
        const tigerMetro = await fetchUsMetroAreaByLatLng(lat, lng);
        if (tigerMetro) effectiveMetroArea = tigerMetro;
      } catch (e) {
        log.warning(`[FIRESTORE] Metro area TIGERweb lookup failed: ${e.message}`);
      }
    }
  }

  // ── adId (best available source) ──────────────────────────────────────────
  const adId = adData._adId || n(prop.adId) || n(scr.adIdOnSite) || n(scr.adId) || null;

  // ── Photos: main extractor first, SCRAPPED fallback ───────────────────────
  const photos = (() => {
    const main = (adData.photos?.items || []).map(p => n(p.url)).filter(Boolean);
    if (main.length) return main;
    // SCRAPPED_AD_DETAILS.photos is an array of URL strings
    return (Array.isArray(scr.photos) ? scr.photos : []).filter(Boolean);
  })();

  // ── Description ───────────────────────────────────────────────────────────
  const description = n(adData.description?.fullDescription) || n(scr.description) || null;

  // ── Structural helpers ────────────────────────────────────────────────────
  const stayType = (typeof avail.stayType === 'object' && avail.stayType !== null && avail.stayType !== 'not_found')
    ? avail.stayType : {};

  // Build neighborhoods object:
  //   - 0 items           → {}
  //   - 1 item            → { primary: "item1" }
  //   - 2 items           → { primary: "item1", secondary: ["item2"] }
  //   - 3+ items          → { primary: "item1", secondary: ["item2", "item3", ...] }
  const neighborhoods = (() => {
    const toArr = (v) => {
      if (Array.isArray(v)) return v.filter(x => x && x !== 'not_found');
      if (v && typeof v === 'string' && v !== 'not_found') return [v];
      return [];
    };

    // Sources in priority order:
    //   1. loc.nearbyNeighborhoods        — deep JSON extractor
    //   2. scr.nearbyNeighborhoods        — SCRAPPED_AD_DETAILS top-level
    //   3. scr.address.nearbyNeighborhoods — SCRAPPED_AD_DETAILS nested under address
    const seen = new Set();
    const nearbyArr = [];
    for (const item of [
      ...toArr(loc.nearbyNeighborhoods),
      ...toArr(scr.nearbyNeighborhoods),
      ...toArr(scr.address?.nearbyNeighborhoods),
    ]) {
      if (!seen.has(item)) { seen.add(item); nearbyArr.push(item); }
    }

    if (!nearbyArr.length) return {};
    if (nearbyArr.length === 1) return { primary: nearbyArr[0] };
    return { primary: nearbyArr[0], secondary: nearbyArr.slice(1) };
  })();

  // ── Preference normalisation ──────────────────────────────────────────────
  const scrTenantPrefs = scr.tenantPreferences || {};
  const scrAddInfo     = scr.additionalInfo    || {};

  const effectiveAgeRange   = matchOption(scrTenantPrefs.ageRange,         AGE_RANGE_OPTIONS)
                           || matchOption(n(prefs.ageRange),                AGE_RANGE_OPTIONS)
                           || null;

  const effectiveOccupation = matchOption(scrTenantPrefs.occupation,        OCCUPATION_OPTIONS)
                           || matchOption(n(prefs.occupation),              OCCUPATION_OPTIONS)
                           || null;

  const effectiveGender     = matchOption(scrTenantPrefs.genderPreference,  GENDER_OPTIONS)
                           || matchOption(n(prefs.preferredGender),         GENDER_OPTIONS)
                           || null;

  const effectivePets       = matchOption(scrAddInfo.pets,                  PETS_OPTIONS)
                           || matchOption(n(prefs.pets),                    PETS_OPTIONS)
                           || null;

  const effectiveSmoking    = matchOption(scrAddInfo.smoking,               SMOKING_OPTIONS)
                           || matchOption(n(prefs.smoking),                 SMOKING_OPTIONS)
                           || null;

  const effectiveVegetarian = matchOption(scrAddInfo.vegNonVeg,             VEGETARIAN_OPTIONS)
                           || matchOption(n(prefs.vegetarian),              VEGETARIAN_OPTIONS)
                           || null;

  const effectiveAlcohol    = normalizeAlcohol(scrTenantPrefs.alcohol)
                           ?? (n(prefs.alcoholAllowed) != null ? Boolean(n(prefs.alcoholAllowed)) : null);

  const effectiveLanguages  = normalizeLanguages(n(prefs.languages));

  return {
    // ── Top-level amenities (key:bool map from DOM + deep extraction) ────────
    amenities,

    // ── Search index ─────────────────────────────────────────────────────────
    _search: {
      adId,
      adactivedate:    activeDateStr    || null,
      adexpirydate:    expiryDateStr    || null,
      adexpirystatus:  n(meta.adExpiryStatus) || 'active',
      baths:           effectiveBaths,
      beds:            effectiveBeds,
      category:        n(meta.category) || 'property',
      city:            (n(loc.city)       || '').toLowerCase(),
      country:         (n(loc.country)    || '').toLowerCase(),
      countryCode:     n(loc.countryCode),
      currency:        effectiveCurrency,
      district:        (n(loc.district)   || '').toLowerCase(),
      intent:          effectiveIntent,
      locality:        (n(loc.locality)   || '').toLowerCase(),
      metroArea:       effectiveMetroArea.toLowerCase(),
      orderId:         n(pay.orderId),
      paymentId:       n(pay.paymentId),
      propertyType:    effectivePropertyType,
      rent:            effectiveRent,
      state:           (n(loc.state)      || '').toLowerCase(),
      stateCode:       n(loc.stateCode),
      status:          n(meta.status) || 'active',
      subLocality:     (n(loc.subLocality) || '').toLowerCase(),
      title_lowercase: (n(prop.title)     || '').toLowerCase(),
      userid:          FIXED_USER.uid,
      zipcode:         n(loc.zipCode),
    },

    adId,

    details: {
      amenities:  Array.isArray(scr.amenities)  ? scr.amenities.filter(Boolean)  : [],
      utilities:  Array.isArray(scr.utilities)  ? scr.utilities.filter(Boolean)  : [],
      availability: {
        daysAvailable: n(avail.daysAvailable),
        from:          effectiveAvailFrom,
        stayType,
        to:            '2100-12-31',
      },
      description,
      openHouse: { date: null, endTime: null, startTime: null },
      rent: {
        amount:            effectiveRent,
        currency:          effectiveCurrency,
        deposit:           n(prop.deposit) ?? 0,
        isHidden:          false,
        isNegotiable:      prop.negotiable === true,
        mode:              effectiveMode,
        title:             n(prop.title),
        utilitiesIncluded: prop.utilitiesIncluded === true,
      },
      location: {
        city:             n(loc.city),
        country:          n(loc.country),
        countryCode:      n(loc.countryCode),
        display:          n(loc.displayAddress) || n(loc.subLocality) || n(loc.city),
        district:         n(loc.district),
        formattedAddress: n(loc.formattedAddress),
        lat:              n(loc.latitude),
        lng:              n(loc.longitude),
        locality:         n(loc.locality),
        metroArea:        effectiveMetroArea || null,
        neighborhoods,
        showOnMap:        priv.mapVisibility !== false && priv.hideAddress !== true,
        state:            n(loc.state),
        stateCode:        n(loc.stateCode),
        subLocality:      n(loc.subLocality),
        zipcode:          n(loc.zipCode),
      },
    },

    metadata: {
      adactivedate:   activeDateStr    || n(meta.adActiveDate),
      adexpirydate:   expiryDateStr    || n(meta.adExpiryDate),
      adexpirystatus: n(meta.adExpiryStatus) || 'active',
      adtimezone:     n(meta.timezone) || 'America/New_York',
      category:       n(meta.category) || 'property',
      createdAt:      activeTimestamp  || FieldValue.serverTimestamp(),
      intent:         effectiveIntent,
      orderId:        n(pay.orderId),
      paymentId:      n(pay.paymentId),
      role:           FIXED_USER.role,
      status:         n(meta.status) || 'active',
      updatedAt:      FieldValue.serverTimestamp(),
    },

    payment: {
      currency:     n(pay._raw?.currency) || 'USD',
      durationDays: n(pay.durationDays),
      method:       n(pay.paymentMethod),
      orderId:      n(pay.orderId),
      paidAmount:   n(pay.paidAmount),
      paidAt:       n(pay.paidAt),
      paymentId:    n(pay.paymentId),
      planId:       n(pay.planId),
      planName:     n(pay.planName),
      promoCode:    n(pay.promoCode),
    },

    photos,

    preferences: {
      ageRange:        effectiveAgeRange,
      alcoholAllowed:  effectiveAlcohol,
      couplesWelcome:  /^yes$/i.test(String(scr.couplesAllowed || ''))
        ? true
        : n(prefs.couplesWelcome),
      languages:       effectiveLanguages,
      occupation:      effectiveOccupation,
      pets:            effectivePets,
      preferredGender: effectiveGender,
      smoking:         effectiveSmoking,
      vegetarian:      effectiveVegetarian,
    },

    privacy: {
      hideAddressOnAd:  priv.hideAddress     === true,
      hideEmailOnAd:    priv.hideEmail       === true,
      hidePhoneOnAd:    priv.hidePhone       === true,
      onWhatsApp:       priv.whatsappEnabled === true,
      sharePhone:       priv.hidePhone       !== true,
      showAddressOnMap: priv.mapVisibility   !== false,
    },

    propertyDetails: {
      accommodationType: n(prop.accommodationType) || '',
      baths:        effectiveBaths,
      beds:         effectiveBeds,
      buildingName: n(prop.buildingName),
      isShared:     false,
      propertyType: n(prop.propertyType),
      squareFeet:   effectiveSqFt,
    },

    user: {
      ...FIXED_USER,
      displayName: scr.postedBy || FIXED_USER.displayName,
    },

    responseCount: 0,

    stats: {
      responseCount: 0,
    },
  };
}

// ─── Save ─────────────────────────────────────────────────────────────────────

/**
 * Save an ad to Firestore.
 * Returns true if newly saved, false if duplicate or error.
 *
 * @param {Object} adData - Fully extracted ad record from extractDetailPage()
 */
export async function saveAdToFirestore(adData) {
  if (!db) {
    log.warning('[FIRESTORE] Not initialized — skipping save.');
    return false;
  }

  const adId = adData._adId || n(adData.property?.adId);
  if (!adId) {
    log.warning('[FIRESTORE] No valid adId found — skipping save.');
    return false;
  }

  try {
    const docRef = db.collection(ADS_COLLECTION).doc(String(adId));
    const existing = await docRef.get();

    if (existing.exists) {
      // Re-save only if any of the three required geo fields are missing.
      const existingLoc = existing.data()?.details?.location || {};
      const missingGeo =
        existingLoc.lat      == null ||
        !existingLoc.locality  ||
        !existingLoc.metroArea;

      if (!missingGeo) {
        log.info(`[FIRESTORE] Ad ${adId} already complete (lat/locality/metroArea present) — skipping.`);
        return false;
      }

      // One or more required fields are null — update location + search index.
      const doc = await buildFirestoreDoc(adData);
      await docRef.update({
        'details.location':  doc.details.location,
        '_search.city':      doc._search.city,
        '_search.district':  doc._search.district,
        '_search.locality':  doc._search.locality,
        '_search.metroArea': doc._search.metroArea,
        '_search.stateCode': doc._search.stateCode,
        '_search.zipcode':   doc._search.zipcode,
        'metadata.updatedAt': FieldValue.serverTimestamp(),
      });
      log.info(`[FIRESTORE] Updated ad ${adId} — filled missing geo fields (lat/locality/metroArea).`);
      return true;
    }

    const doc = await buildFirestoreDoc(adData);
    await docRef.set(doc);
    log.info(`[FIRESTORE] Saved ad ${adId} to "${ADS_COLLECTION}" collection.`);
    return true;
  } catch (err) {
    log.error(`[FIRESTORE] Save failed for ad ${adId}: ${err.message}`);
    return false;
  }
}
