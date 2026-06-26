/**
 * extract.js
 * All data extraction logic for Sulekha rental detail pages.
 *
 * Priority order:
 *   1. window.__NEXT_DATA__ / window.__INITIAL_STATE__ / Firebase blobs
 *   2. script[type="application/ld+json"]
 *   3. Other embedded JSON script tags
 *   4. Intercepted XHR/API payloads (passed in as apiPayloads)
 *   5. DOM fallback (cheerio)
 *
 * All extracted objects are deep-merged and missing values normalized.
 */

import { load as cheerioLoad } from 'cheerio';
import { log } from 'crawlee';
import { Client as GoogleMapsClient } from '@googlemaps/google-maps-services-js';
import {
  safeJsonParse,
  deepMerge,
  normalizeMissing,
  extractAdIdFromUrl,
  truncate,
} from './helpers.js';

// ─── Address parsing constants ────────────────────────────────────────────────

const COUNTRY_MAP = {
  'USA':           { country: 'United States', countryCode: 'US' },
  'US':            { country: 'United States', countryCode: 'US' },
  'UNITED STATES': { country: 'United States', countryCode: 'US' },
  'UK':            { country: 'United Kingdom', countryCode: 'GB' },
  'UNITED KINGDOM':{ country: 'United Kingdom', countryCode: 'GB' },
  'CANADA':        { country: 'Canada',          countryCode: 'CA' },
  'INDIA':         { country: 'India',           countryCode: 'IN' },
  'AUSTRALIA':     { country: 'Australia',       countryCode: 'AU' },
};

const US_STATE_NAMES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
  CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
  HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',
  KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',
  MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',
  MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',
  OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',
  VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
  DC:'District of Columbia',
};

// ─── Top-level extractor ─────────────────────────────────────────────────────

/**
 * Master extraction function.
 * @param {Object} params
 * @param {string}   params.url        - The detail page URL
 * @param {string}   params.html       - Full page HTML
 * @param {Object[]} params.apiPayloads - Array of { url, data } from intercepted XHR/fetch
 * @param {Object}   params.inputConfig - Actor input config flags
 * @param {Object}   [params.page]      - Playwright page object for live DOM extraction
 * @returns {Object} Fully extracted, merged, normalized rental ad object
 */
export async function extractDetailPage({ url, html, apiPayloads = [], inputConfig = {}, page = null }) {
  const $ = cheerioLoad(html);

  // Step 1: Extract all JSON sources
  const nextData = inputConfig.extractNextData !== false ? extractNextData($, html) : null;
  const initialState = extractWindowVar(html, '__INITIAL_STATE__');
  const firebaseData = extractWindowVar(html, '__FIREBASE_DATA__');
  const ldJsonItems = inputConfig.extractLdJson !== false ? extractLdJson($) : [];
  const embeddedJsonObjects = extractAllEmbeddedJson($, html);

  // Step 2: Flatten apiPayloads into merged object
  const apiMerged = mergeApiPayloads(apiPayloads);

  // Step 3: Merge all sources (priority: nextData > initialState > apiMerged > embedded > ldJson > firebase)
  const rawMerged = deepMerge(
    {},
    ...(ldJsonItems.length ? ldJsonItems : [{}]),
    ...(embeddedJsonObjects.length ? embeddedJsonObjects : [{}]),
    firebaseData || {},
    apiMerged || {},
    initialState || {},
    nextData || {},
  );

  // Step 4: Build a structured ad record from merged data
  const adRecord = buildAdRecord(url, rawMerged, $, apiPayloads);

  // Step 4.5: Enrich missing location fields via Google Geocoding API.
  // parseSulekhaFullAddress() already filled city/state/zip from fullAddress (Step 4);
  // this async step adds lat/lng + any still-missing fields via Google, then
  // resolves metroArea via TIGERweb CBSA using the returned coordinates.
  if (adRecord.location && typeof adRecord.location === 'object') {
    await enrichLocationGeo(adRecord.location, inputConfig.googleMapsApiKey);
  }

  // Step 5: Extract live DOM fields (page-dependent) and merge
  if (page) {
    try {
      const domData = await extractLiveDom(page);
      mergeDomIntoRecord(adRecord, domData);
    } catch (err) {
      log.warning(`[EXTRACT] Live DOM extraction failed: ${err.message}`);
    }
  } else {
    log.debug('[EXTRACT] No Playwright page provided — skipping live DOM extraction.');
  }

  // Step 6: Normalize missing values
  return normalizeMissing(adRecord);
}

// ─── Source 1: __NEXT_DATA__ ─────────────────────────────────────────────────

function extractNextData($, html) {
  // Try script#__NEXT_DATA__ first
  const scriptEl = $('script#__NEXT_DATA__').text();
  if (scriptEl) {
    const parsed = safeJsonParse(scriptEl);
    if (parsed) return parsed;
  }

  // Try regex from raw HTML
  const patterns = [
    /window\.__NEXT_DATA__\s*=\s*({[\s\S]*?});\s*(?:window|<\/script>)/,
    /__NEXT_DATA__\s*=\s*({[\s\S]*?})\s*;/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const parsed = safeJsonParse(match[1]);
      if (parsed) return parsed;
    }
  }
  return null;
}

// ─── Source 2: Any window.<VAR> ───────────────────────────────────────────────

function extractWindowVar(html, varName) {
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`window\\.${escaped}\\s*=\\s*({[\\s\\S]*?});\\s*(?:window|<\\/script>)`),
    new RegExp(`window\\.${escaped}\\s*=\\s*({[\\s\\S]*?})\\s*;`),
    new RegExp(`${escaped}\\s*=\\s*({[\\s\\S]*?})\\s*;`),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const parsed = safeJsonParse(match[1]);
      if (parsed) return parsed;
    }
  }
  return null;
}

// ─── Source 3: script[type="application/ld+json"] ────────────────────────────

function extractLdJson($) {
  const items = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).text().trim();
    const parsed = safeJsonParse(text);
    if (parsed) items.push(parsed);
  });
  return items;
}

// ─── Source 4: All embedded JSON-like script blobs ───────────────────────────

function extractAllEmbeddedJson($, html) {
  const results = [];
  const seen = new Set();

  // Extract from all <script> tags without type or with type=text/javascript
  $('script:not([src])').each((_, el) => {
    const text = $(el).text().trim();
    if (!text || text.length < 20) return;
    if (seen.has(text)) return;
    seen.add(text);

    // Look for JSON object/array assignments
    const patterns = [
      // var/const/let X = {...}
      /(?:var|const|let)\s+\w+\s*=\s*(\{[\s\S]{10,}\})\s*;/g,
      // window.X = {...}
      /window\.\w+\s*=\s*(\{[\s\S]{10,}\})\s*;/g,
      // self.X = {...}
      /self\.\w+\s*=\s*(\{[\s\S]{10,}\})\s*;/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const parsed = safeJsonParse(match[1]);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          results.push(parsed);
        }
      }
    }

    // Also try parsing entire script content as JSON
    const wholeParsed = safeJsonParse(text);
    if (wholeParsed && typeof wholeParsed === 'object') {
      results.push(wholeParsed);
    }
  });

  // Also look for JSON-like data attributes on meta tags
  $('meta[name], meta[property]').each((_, el) => {
    const content = $(el).attr('content');
    if (content && content.startsWith('{')) {
      const parsed = safeJsonParse(content);
      if (parsed) results.push(parsed);
    }
  });

  return results;
}

// ─── Source 5: API payloads ──────────────────────────────────────────────────

function mergeApiPayloads(apiPayloads) {
  if (!apiPayloads || !apiPayloads.length) return {};
  let merged = {};
  for (const payload of apiPayloads) {
    if (!payload || !payload.data) continue;
    const data = typeof payload.data === 'string' ? safeJsonParse(payload.data) : payload.data;
    if (data && typeof data === 'object') {
      merged = deepMerge(merged, data);
    }
  }
  return merged;
}

// ─── Build Ad Record ─────────────────────────────────────────────────────────

/**
 * Navigate the merged raw data structure to extract known fields,
 * and also preserve the full raw object for future-proofing.
 */
function buildAdRecord(url, raw, $, apiPayloads) {
  // Attempt to find the ad data node inside Next.js page props
  const adNode = findAdNode(raw);

  const adId = extractAdId(url, adNode, raw);
  const scrapedAt = new Date().toISOString();

  return {
    // ── Meta ──────────────────────────────────────────────────────
    _scrapedAt: scrapedAt,
    _sourceUrl: url,
    _adId: adId,

    // ── A. Property Information ───────────────────────────────────
    property: extractProperty(adNode, raw, $),

    // ── B. Description ────────────────────────────────────────────
    description: extractDescription(adNode, raw, $),

    // ── C. Availability ───────────────────────────────────────────
    availability: extractAvailability(adNode, raw, $),

    // ── D. Location ───────────────────────────────────────────────
    location: extractLocation(adNode, raw, $),

    // ── E. Photos ─────────────────────────────────────────────────
    photos: extractPhotos(adNode, raw, $),

    // ── F. Amenities ──────────────────────────────────────────────
    amenities: extractAmenities(adNode, raw, $),

    // ── G. Preferences ────────────────────────────────────────────
    preferences: extractPreferences(adNode, raw, $),

    // ── H. Poster / User ─────────────────────────────────────────
    poster: extractPoster(adNode, raw, $),

    // ── I. Payment ────────────────────────────────────────────────
    payment: extractPayment(adNode, raw),

    // ── J. Metadata ───────────────────────────────────────────────
    metadata: extractMetadata(adNode, raw, $, url),

    // ── K. Privacy Settings ───────────────────────────────────────
    privacy: extractPrivacy(adNode, raw),

    // ── L. SEO / LD+JSON ─────────────────────────────────────────
    structuredData: extractStructuredDataSection(raw, $),

    // ── M. API Payloads captured ──────────────────────────────────
    capturedApiEndpoints: (apiPayloads || []).map((p) => p.url).filter(Boolean),

    // ── N. Full raw data (future-proof) ──────────────────────────
    _rawData: raw,
  };
}

// ─── Locate Ad Node Inside Next.js Structure ─────────────────────────────────

function findAdNode(raw) {
  if (!raw || typeof raw !== 'object') return {};

  // Next.js typical: raw.props.pageProps.<adKey>
  const pageProps = deepGet(raw, ['props', 'pageProps']);
  if (pageProps) {
    // Try common keys
    for (const key of ['adDetails', 'ad', 'listing', 'rentalAd', 'adData', 'postDetails', 'post']) {
      if (pageProps[key] && typeof pageProps[key] === 'object') return pageProps[key];
    }
    // Return pageProps itself if it has adId or id
    if (pageProps.adId || pageProps.id || pageProps.uid) return pageProps;
  }

  // Firebase / flat structure
  for (const key of ['adDetails', 'ad', 'listing', 'rentalAd', 'adData', 'data', 'result', 'postDetails']) {
    if (raw[key] && typeof raw[key] === 'object') return raw[key];
  }

  return raw;
}

// ─── Extraction Helpers ──────────────────────────────────────────────────────

function coalesce(...args) {
  for (const v of args) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/**
 * Safe deep-get from object. Returns undefined if path not found.
 */
function deepGet(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function getText($, selectors) {
  for (const sel of selectors) {
    const text = $(sel).first().text().trim();
    if (text) return text;
  }
  return undefined;
}

function getAttr($, selectors, attr) {
  for (const sel of selectors) {
    const val = $(sel).first().attr(attr);
    if (val) return val;
  }
  return undefined;
}

// ─── Sulekha fullAddress parser ───────────────────────────────────────────────

/**
 * Parse Sulekha's concatenated fullAddress string into structured location fields.
 *
 * Handles formats like:
 *   "3411 Wichita Street, Houston, TX, USA, 77004Houston, TXHarris County View on Map..."
 *   "Jersey City, NJ, USA, 07302 | Hudson County | ..."
 */
function parseSulekhaFullAddress(fullAddress) {
  if (!fullAddress || typeof fullAddress !== 'string') return {};
  const text = fullAddress;
  const result = {};

  // 1. ZIP code (5-digit US, optionally -4 suffix)
  const zipMatch = text.match(/\b(\d{5})(?:-\d{4})?\b/);
  if (zipMatch) result.zipCode = zipMatch[1];

  // 2. Country keyword
  for (const [keyword, info] of Object.entries(COUNTRY_MAP)) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(text)) {
      result.country = info.country;
      result.countryCode = info.countryCode;
      break;
    }
  }

  // 3. State code: look for ", XX," or ", XX " pattern (2 uppercase letters)
  const stateCodeMatch = text.match(/,\s*([A-Z]{2})(?:[,\s]|$)/);
  if (stateCodeMatch) {
    const code = stateCodeMatch[1];
    result.stateCode = code;
    result.state = US_STATE_NAMES[code] || code;
  }

  // 4. City: shortest letter-sequence that sits directly before ", StateCode"
  //    Non-greedy so "Wichita Street, Houston, TX" resolves to "Houston", not "Wichita Street"
  if (result.stateCode) {
    const cityRegex = new RegExp(`([A-Za-z][A-Za-z ]{1,35}?),\\s*${result.stateCode}(?:[,\\s]|$)`);
    const cityMatch = text.match(cityRegex);
    if (cityMatch) {
      // If the match spans a comma (e.g. "Street, Houston") take only the last segment
      const segments = cityMatch[1].trim().split(',');
      result.city = segments[segments.length - 1].trim();
    }
  }

  // 5. County / district
  const countyMatch = text.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Za-z]+)*\s+County)\b/);
  if (countyMatch) result.district = countyMatch[1].trim();

  // 6. Build a normalised formattedAddress
  const parts = [result.city, result.stateCode, result.zipCode, result.country].filter(Boolean);
  if (parts.length >= 2) result.formattedAddress = parts.join(', ');

  return result;
}

// ─── Google Maps Geocoding ────────────────────────────────────────────────────

const _googleMapsClient = new GoogleMapsClient({});

/**
 * Geocode a ZIP code via the Google Maps Geocoding API.
 * Returns a structured location object with all address fields + lat/lng.
 */
async function geocodeByZipGoogle(zipCode, countryCode, apiKey) {
  if (!apiKey || !zipCode) return null;
  const cc = (countryCode || 'US').toUpperCase();

  try {
    const response = await _googleMapsClient.geocode({
      params: {
        address: zipCode,
        components: `country:${cc}|postal_code:${zipCode}`,
        key: apiKey,
      },
      timeout: 10000,
    });

    if (response.data.status !== 'OK' || !response.data.results.length) {
      log.debug(`[GEOCODE] Google returned status=${response.data.status} for zip=${zipCode}`);
      return null;
    }

    const place = response.data.results[0];
    const components = place.address_components || [];

    // Helper: find first component of a given type
    const get = (type, nameField = 'long_name') => {
      const comp = components.find(c => c.types.includes(type));
      return comp ? comp[nameField] : null;
    };

    const lat = place.geometry?.location?.lat ?? null;
    const lng = place.geometry?.location?.lng ?? null;

    return {
      lat,
      lng,
      formattedAddress: place.formatted_address || null,
      // City: "locality" is standard; fall back to sub-city levels for some regions
      city:        get('locality') || get('sublocality_level_1') || get('administrative_area_level_3') || get('administrative_area_level_2'),
      locality:    get('neighborhood') || get('sublocality_level_2') || get('sublocality_level_1'),
      subLocality: get('sublocality_level_1'),
      district:    get('administrative_area_level_2'),   // county / district
      state:       get('administrative_area_level_1'),   // full state name
      stateCode:   get('administrative_area_level_1', 'short_name'),
      country:     get('country'),
      countryCode: get('country', 'short_name'),
      zipCode:     get('postal_code') || zipCode,
    };
  } catch (err) {
    log.warning(`[GEOCODE] Google Geocoding failed for zip=${zipCode}: ${err.message}`);
    return null;
  }
}

// ─── MSA / metro-area lookup via TIGERweb (US only) ─────────────────────────
// Google Geocoding does not return MSA/CBSA data, so we use TIGERweb for this.

async function resolveMetroAreaFromCoords(lat, lng) {
  if (lat == null || lng == null) return null;
  try {
    const url =
      `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/CBSA/MapServer/0/query` +
      `?geometry=${lng},${lat}&geometryType=esriGeometryPoint&spatialRel=esriSpatialRelIntersects` +
      `&outFields=NAME&returnGeometry=false&f=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const name = data?.features?.[0]?.attributes?.NAME;
    return name ? name.replace(/\s*Metro(?:politan)?\s+(?:Statistical\s+)?Area\b.*/i, '').trim() : null;
  } catch (err) {
    log.debug(`[METRO] TIGERweb failed for (${lat},${lng}): ${err.message}`);
  }
  return null;
}

// ─── Enrich location with Google Geocoding data ───────────────────────────────

/**
 * Call Google Geocoding API with the location's ZIP code and back-fill any
 * missing fields (lat, lng, city, state, country, district, metroArea, etc.).
 * Only overwrites fields that are currently null/missing.
 *
 * @param {Object} location   - The location sub-object from adRecord
 * @param {string} apiKey     - Google Maps API key from actor input
 */
async function enrichLocationGeo(location, apiKey) {
  if (!location || typeof location !== 'object') return;
  if (!apiKey) {
    log.debug('[GEOCODE] No googleMapsApiKey provided — skipping geo enrichment.');
    return;
  }

  const zip = location.zipCode;
  const cc  = location.countryCode || 'US';

  if (!zip || zip === 'not_found') return;

  const geo = await geocodeByZipGoogle(zip, cc, apiKey);
  if (!geo) return;

  log.info(`[GEOCODE] ${zip}/${cc} → lat=${geo.lat}, lng=${geo.lng}, city=${geo.city}, district=${geo.district}`);

  // Back-fill only missing fields — never overwrite values already scraped from the page
  if (geo.lat  != null && location.latitude  == null) location.latitude  = geo.lat;
  if (geo.lng  != null && location.longitude == null) location.longitude = geo.lng;
  if (geo.city         && !location.city)             location.city         = geo.city;
  if (geo.locality     && !location.locality)         location.locality     = geo.locality;
  if (geo.subLocality  && !location.subLocality)      location.subLocality  = geo.subLocality;
  if (geo.district     && !location.district)         location.district     = geo.district;
  if (geo.state        && !location.state)            location.state        = geo.state;
  if (geo.stateCode    && !location.stateCode)        location.stateCode    = geo.stateCode;
  if (geo.country      && !location.country)          location.country      = geo.country;
  if (geo.countryCode  && !location.countryCode)      location.countryCode  = geo.countryCode;
  if (geo.zipCode      && !location.zipCode)          location.zipCode      = geo.zipCode;
  if (geo.formattedAddress && !location.formattedAddress) location.formattedAddress = geo.formattedAddress;

  // Metro area (US only): TIGERweb CBSA lookup using lat/lng from Google
  const isUS = (geo.countryCode || cc).toUpperCase() === 'US';
  if (isUS && geo.lat != null && (!location.metroArea || location.metroArea === 'not_found')) {
    const metro = await resolveMetroAreaFromCoords(geo.lat, geo.lng);
    if (metro) {
      location.metroArea = metro;
      log.info(`[METRO] ${zip} → ${metro}`);
    }
  }
}

// ─── A. Property ─────────────────────────────────────────────────────────────

function extractProperty(ad, raw, $) {
  return {
    adId: coalesce(
      deepGet(ad, ['adId']),
      deepGet(ad, ['id']),
      deepGet(ad, ['listingId']),
      deepGet(raw, ['query', 'adId']),
    ),
    title: coalesce(
      deepGet(ad, ['title']),
      deepGet(ad, ['adTitle']),
      deepGet(ad, ['heading']),
      getText($, ['h1', '.ad-title', '.listing-title', '[class*="title"]']),
    ),
    listingUrl: coalesce(deepGet(ad, ['listingUrl']), deepGet(ad, ['url']), deepGet(ad, ['canonicalUrl'])),
    propertyType: coalesce(
      deepGet(ad, ['propertyType']),
      deepGet(ad, ['type']),
      deepGet(ad, ['accommodationType']),
      deepGet(ad, ['roomType']),
    ),
    accommodationType: coalesce(
      deepGet(ad, ['accommodationType']),
      deepGet(ad, ['accomodationType']),
      deepGet(ad, ['roomType']),
    ),
    buildingName: coalesce(deepGet(ad, ['buildingName']), deepGet(ad, ['buildingInfo', 'name'])),
    beds: coalesce(
      deepGet(ad, ['beds']),
      deepGet(ad, ['bedrooms']),
      deepGet(ad, ['noOfBedrooms']),
      deepGet(ad, ['bedroom']),
    ),
    baths: coalesce(
      deepGet(ad, ['baths']),
      deepGet(ad, ['bathrooms']),
      deepGet(ad, ['noOfBathrooms']),
      deepGet(ad, ['bathroom']),
    ),
    squareFeet: coalesce(
      deepGet(ad, ['squareFeet']),
      deepGet(ad, ['sqft']),
      deepGet(ad, ['area']),
      deepGet(ad, ['builtupArea']),
    ),
    rentAmount: coalesce(
      deepGet(ad, ['rent']),
      deepGet(ad, ['rentAmount']),
      deepGet(ad, ['price']),
      deepGet(ad, ['amount']),
      deepGet(ad, ['monthlyRent']),
    ),
    rentCurrency: coalesce(
      deepGet(ad, ['currency']),
      deepGet(ad, ['rentCurrency']),
      deepGet(ad, ['priceCurrency']),
      'USD',
    ),
    deposit: coalesce(deepGet(ad, ['deposit']), deepGet(ad, ['securityDeposit']), deepGet(ad, ['depositAmount'])),
    rentFrequency: coalesce(deepGet(ad, ['rentFrequency']), deepGet(ad, ['frequency']), deepGet(ad, ['billingCycle'])),
    utilitiesIncluded: coalesce(
      deepGet(ad, ['utilitiesIncluded']),
      deepGet(ad, ['utilities']),
      deepGet(ad, ['utilityIncluded']),
    ),
    negotiable: coalesce(deepGet(ad, ['negotiable']), deepGet(ad, ['isNegotiable']), deepGet(ad, ['priceNegotiable'])),
    propertyOwnerOrAgent: coalesce(
      deepGet(ad, ['postedBy']),
      deepGet(ad, ['ownerType']),
      deepGet(ad, ['role']),
      deepGet(ad, ['sellerType']),
    ),
    // dynamic extra fields at property level
    _extra: extractDynamicFields(ad, [
      'adId', 'id', 'listingId', 'title', 'adTitle', 'heading', 'listingUrl', 'url', 'canonicalUrl',
      'propertyType', 'type', 'accommodationType', 'accomodationType', 'roomType', 'buildingName',
      'beds', 'bedrooms', 'noOfBedrooms', 'bedroom', 'baths', 'bathrooms', 'noOfBathrooms', 'bathroom',
      'squareFeet', 'sqft', 'area', 'builtupArea', 'rent', 'rentAmount', 'price', 'amount', 'monthlyRent',
      'currency', 'rentCurrency', 'priceCurrency', 'deposit', 'securityDeposit', 'depositAmount',
      'rentFrequency', 'frequency', 'billingCycle', 'utilitiesIncluded', 'utilities', 'utilityIncluded',
      'negotiable', 'isNegotiable', 'priceNegotiable', 'postedBy', 'ownerType', 'role', 'sellerType',
    ]),
  };
}

// ─── B. Description ──────────────────────────────────────────────────────────

function extractDescription(ad, raw, $) {
  return {
    fullDescription: coalesce(
      deepGet(ad, ['description']),
      deepGet(ad, ['adDescription']),
      deepGet(ad, ['details']),
      deepGet(ad, ['aboutProperty']),
      getText($, ['.ad-description', '.description', '[class*="description"]', '[itemprop="description"]']),
    ),
    extraNotes: coalesce(
      deepGet(ad, ['extraNotes']),
      deepGet(ad, ['notes']),
      deepGet(ad, ['specialInstructions']),
      deepGet(ad, ['additionalInfo']),
    ),
    specialInstructions: coalesce(
      deepGet(ad, ['specialInstructions']),
      deepGet(ad, ['instructions']),
      deepGet(ad, ['requirements']),
    ),
  };
}

// ─── C. Availability ─────────────────────────────────────────────────────────

function extractAvailability(ad, raw, $) {
  return {
    availableFrom: coalesce(
      deepGet(ad, ['availableFrom']),
      deepGet(ad, ['availFrom']),
      deepGet(ad, ['moveInDate']),
      deepGet(ad, ['availableDate']),
      deepGet(ad, ['dateAvailable']),
    ),
    availableTo: coalesce(
      deepGet(ad, ['availableTo']),
      deepGet(ad, ['availTo']),
      deepGet(ad, ['moveOutDate']),
    ),
    stayType: coalesce(
      deepGet(ad, ['stayType']),
      deepGet(ad, ['leaseTerm']),
      deepGet(ad, ['leaseType']),
      deepGet(ad, ['term']),
    ),
    daysAvailable: coalesce(
      deepGet(ad, ['daysAvailable']),
      deepGet(ad, ['availabilityDays']),
      deepGet(ad, ['daysOfWeek']),
    ),
    shortTermAllowed: coalesce(
      deepGet(ad, ['shortTermAllowed']),
      deepGet(ad, ['shortTerm']),
      deepGet(ad, ['allowShortTerm']),
    ),
    longTermAllowed: coalesce(
      deepGet(ad, ['longTermAllowed']),
      deepGet(ad, ['longTerm']),
      deepGet(ad, ['allowLongTerm']),
    ),
  };
}

// ─── D. Location ─────────────────────────────────────────────────────────────

function extractLocation(ad, raw, $) {
  const loc = coalesce(
    deepGet(ad, ['location']),
    deepGet(ad, ['address']),
    deepGet(ad, ['locationInfo']),
    deepGet(ad, ['geoLocation']),
    {},
  );
  const locObj = typeof loc === 'object' ? loc : {};

  const result = {
    fullAddress: coalesce(
      deepGet(ad, ['fullAddress']),
      deepGet(ad, ['address']),
      deepGet(locObj, ['fullAddress']),
      deepGet(locObj, ['address']),
      getText($, ['[itemprop="address"]', '.address', '[class*="address"]']),
    ),
    city: coalesce(
      deepGet(ad, ['city']),
      deepGet(locObj, ['city']),
      deepGet(locObj, ['cityName']),
      deepGet(ad, ['cityName']),
    ),
    state: coalesce(
      deepGet(ad, ['state']),
      deepGet(locObj, ['state']),
      deepGet(locObj, ['stateName']),
      deepGet(ad, ['stateName']),
    ),
    stateCode: coalesce(
      deepGet(ad, ['stateCode']),
      deepGet(locObj, ['stateCode']),
      deepGet(ad, ['stateShort']),
    ),
    country: coalesce(
      deepGet(ad, ['country']),
      deepGet(locObj, ['country']),
      deepGet(locObj, ['countryName']),
    ),
    countryCode: coalesce(
      deepGet(ad, ['countryCode']),
      deepGet(locObj, ['countryCode']),
    ),
    district: coalesce(deepGet(ad, ['district']), deepGet(locObj, ['district'])),
    locality: coalesce(
      deepGet(ad, ['locality']),
      deepGet(locObj, ['locality']),
      deepGet(ad, ['neighborhood']),
      deepGet(locObj, ['neighborhood']),
    ),
    metroArea: coalesce(
      deepGet(ad, ['metroArea']),
      deepGet(locObj, ['metroArea']),
      deepGet(ad, ['metro']),
      deepGet(ad, ['msaName']),
    ),
    subLocality: coalesce(deepGet(ad, ['subLocality']), deepGet(locObj, ['subLocality'])),
    zipCode: coalesce(
      deepGet(ad, ['zipCode']),
      deepGet(ad, ['zipcode']),
      deepGet(ad, ['postalCode']),
      deepGet(ad, ['zip']),
      deepGet(locObj, ['zipCode']),
      deepGet(locObj, ['zip']),
    ),
    displayAddress: coalesce(
      deepGet(ad, ['displayAddress']),
      deepGet(locObj, ['displayAddress']),
    ),
    formattedAddress: coalesce(
      deepGet(ad, ['formattedAddress']),
      deepGet(locObj, ['formattedAddress']),
    ),
    latitude: coalesce(
      deepGet(ad, ['lat']),
      deepGet(ad, ['latitude']),
      deepGet(locObj, ['lat']),
      deepGet(locObj, ['latitude']),
      deepGet(ad, ['geoLat']),
    ),
    longitude: coalesce(
      deepGet(ad, ['lng']),
      deepGet(ad, ['lon']),
      deepGet(ad, ['longitude']),
      deepGet(locObj, ['lng']),
      deepGet(locObj, ['longitude']),
      deepGet(ad, ['geoLng']),
    ),
    mapVisibility: coalesce(
      deepGet(ad, ['mapVisibility']),
      deepGet(ad, ['showMap']),
      deepGet(locObj, ['mapVisibility']),
    ),
    neighborhoods: coalesce(
      deepGet(ad, ['neighborhoods']),
      deepGet(locObj, ['neighborhoods']),
      deepGet(ad, ['nearbyNeighborhoods']),
    ),
    nearbyLandmarks: coalesce(
      deepGet(ad, ['nearbyLandmarks']),
      deepGet(ad, ['landmarks']),
      deepGet(locObj, ['landmarks']),
    ),
    _rawLocationObject: loc,
  };

  // Fallback: parse the concatenated fullAddress string when individual fields
  // are missing (common with Sulekha pages that don't expose structured location JSON).
  const fullAddr = result.fullAddress;
  if (fullAddr && typeof fullAddr === 'string' && fullAddr !== 'not_found') {
    const parsed = parseSulekhaFullAddress(fullAddr);
    if (!result.city             && parsed.city)             result.city             = parsed.city;
    if (!result.country          && parsed.country)          result.country          = parsed.country;
    if (!result.countryCode      && parsed.countryCode)      result.countryCode      = parsed.countryCode;
    if (!result.district         && parsed.district)         result.district         = parsed.district;
    if (!result.zipCode          && parsed.zipCode)          result.zipCode          = parsed.zipCode;
    if (!result.state            && parsed.state)            result.state            = parsed.state;
    if (!result.stateCode        && parsed.stateCode)        result.stateCode        = parsed.stateCode;
    if (!result.formattedAddress && parsed.formattedAddress) result.formattedAddress = parsed.formattedAddress;
  }

  return result;
}

// ─── E. Photos ────────────────────────────────────────────────────────────────

function extractPhotos(ad, raw, $) {
  let photos = [];

  // From ad node
  const candidates = [
    deepGet(ad, ['photos']),
    deepGet(ad, ['images']),
    deepGet(ad, ['imageUrls']),
    deepGet(ad, ['photoUrls']),
    deepGet(ad, ['gallery']),
    deepGet(ad, ['media']),
    deepGet(ad, ['pictures']),
  ];

  for (const c of candidates) {
    if (Array.isArray(c) && c.length) {
      photos = c;
      break;
    }
  }

  // Normalize photo objects
  const normalized = photos.map((p, idx) => {
    if (typeof p === 'string') {
      return { index: idx, url: p, alt: null, metadata: null };
    }
    if (typeof p === 'object') {
      return {
        index: idx,
        url: coalesce(p.url, p.src, p.imageUrl, p.photoUrl, p.original, p.large, p.medium, p.thumb),
        alt: coalesce(p.alt, p.caption, p.title, p.description),
        metadata: p,
      };
    }
    return null;
  }).filter(Boolean);

  // DOM fallback: only look inside the primary gallery container.
  // Explicitly skip related/similar listing sections and ad banners.
  if (!normalized.length) {
    const EXCLUDED_SECTIONS = [
      '[class*="similar"]', '[class*="related"]', '[class*="explore"]',
      '[class*="nearby"]', '[class*="browse"]', '[class*="recommend"]',
      '[class*="sponsor"]', '[class*="advertisement"]', '[class*="other-listing"]',
      '[class*="more-listing"]', '[class*="carousel-item"] [class*="card"]',
    ].join(', ');

    // Collect elements that are inside excluded sections so we can skip them
    const excludedEls = new Set();
    $(EXCLUDED_SECTIONS).find('img').each((_, el) => excludedEls.add(el));

    // Primary gallery containers only — stop at the first one that has images.
    // #photoDiv / .roomimageblock are Sulekha's own gallery IDs (highest priority).
    const galleryCandidates = [
      '#photoDiv',
      '.roomimageblock',
      '[class*="photo-gallery"]',
      '[class*="listing-photo"]',
      '[class*="property-photo"]',
      '[class*="image-gallery"]',
      '[class*="gallery"]',
      '[class*="carousel"]',
      '[class*="slider"]',
      '[class*="swiper"]',
    ];

    let found = false;
    for (const sel of galleryCandidates) {
      const container = $(sel).first();
      if (!container.length) continue;

      container.find('img').each((i, el) => {
        if (excludedEls.has(el)) return;
        const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('data-original');
        const alt = $(el).attr('alt') || '';
        if (!src || src.startsWith('data:')) return;
        if (/logo|icon|banner|sponsor|avatar|profile|badge|star|rating/i.test(src)) return;
        if (alt && /logo|icon|banner|sponsor/i.test(alt)) return;
        normalized.push({ index: normalized.length, url: src, alt: alt || null, metadata: null });
        found = true;
      });

      if (found) break;
    }
  }

  return {
    count: normalized.length,
    items: normalized,
  };
}

// ─── F. Amenities ────────────────────────────────────────────────────────────

function extractAmenities(ad, raw, $) {
  let amenityData = {};

  // From ad node - try various keys
  const candidates = [
    deepGet(ad, ['amenities']),
    deepGet(ad, ['facilities']),
    deepGet(ad, ['features']),
    deepGet(ad, ['houseFeatures']),
    deepGet(ad, ['roomFeatures']),
    deepGet(ad, ['utilities']),
    deepGet(ad, ['included']),
  ];

  for (const c of candidates) {
    if (!c) continue;
    if (Array.isArray(c)) {
      // Array of strings or objects
      for (const item of c) {
        if (typeof item === 'string') {
          amenityData[item.toLowerCase().replace(/\s+/g, '_')] = true;
        } else if (typeof item === 'object' && item.name) {
          const k = item.name.toLowerCase().replace(/\s+/g, '_');
          amenityData[k] = item.available !== undefined ? item.available : item.value !== undefined ? item.value : true;
        }
      }
    } else if (typeof c === 'object') {
      // Object with key: boolean/value pairs
      amenityData = { ...amenityData, ...c };
    }
  }

  // DOM fallback: collect all checked/available amenity labels
  if (!Object.keys(amenityData).length) {
    $('[class*="amenity"], [class*="amenities"], [class*="feature"], [class*="facility"]').each((_, el) => {
      const text = $(el).text().trim();
      if (text && text.length < 60) {
        amenityData[text.toLowerCase().replace(/\s+/g, '_')] = true;
      }
    });
  }

  return amenityData;
}

// ─── G. Preferences ──────────────────────────────────────────────────────────

function extractPreferences(ad, raw, $) {
  const prefs = coalesce(deepGet(ad, ['preferences']), deepGet(ad, ['roommatePreferences']), deepGet(ad, ['tenantPreferences']), {});
  const prefsObj = typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};

  return {
    preferredGender: coalesce(
      deepGet(ad, ['preferredGender']),
      deepGet(prefsObj, ['gender']),
      deepGet(ad, ['gender']),
      deepGet(ad, ['genderPreference']),
    ),
    pets: coalesce(
      deepGet(ad, ['pets']),
      deepGet(ad, ['petsAllowed']),
      deepGet(prefsObj, ['pets']),
    ),
    smoking: coalesce(
      deepGet(ad, ['smoking']),
      deepGet(ad, ['smokingAllowed']),
      deepGet(prefsObj, ['smoking']),
    ),
    vegetarian: coalesce(
      deepGet(ad, ['vegetarian']),
      deepGet(ad, ['vegOnly']),
      deepGet(prefsObj, ['vegetarian']),
    ),
    alcoholAllowed: coalesce(
      deepGet(ad, ['alcoholAllowed']),
      deepGet(ad, ['alcohol']),
      deepGet(prefsObj, ['alcohol']),
    ),
    couplesWelcome: coalesce(
      deepGet(ad, ['couplesWelcome']),
      deepGet(ad, ['couples']),
      deepGet(prefsObj, ['couples']),
    ),
    ageRange: coalesce(
      deepGet(ad, ['ageRange']),
      deepGet(ad, ['preferredAge']),
      deepGet(prefsObj, ['ageRange']),
    ),
    occupation: coalesce(
      deepGet(ad, ['occupation']),
      deepGet(ad, ['preferredOccupation']),
      deepGet(prefsObj, ['occupation']),
    ),
    languages: coalesce(
      deepGet(ad, ['languages']),
      deepGet(ad, ['preferredLanguages']),
      deepGet(prefsObj, ['languages']),
    ),
    // Preserve full raw preferences object
    _raw: prefsObj,
  };
}

// ─── H. Poster ───────────────────────────────────────────────────────────────

function extractPoster(ad, raw, $) {
  const user = coalesce(
    deepGet(ad, ['user']),
    deepGet(ad, ['poster']),
    deepGet(ad, ['postedByUser']),
    deepGet(ad, ['author']),
    deepGet(ad, ['owner']),
    deepGet(ad, ['contact']),
    {},
  );
  const userObj = typeof user === 'object' ? user : {};

  return {
    displayName: coalesce(
      deepGet(userObj, ['displayName']),
      deepGet(userObj, ['name']),
      deepGet(userObj, ['fullName']),
      deepGet(ad, ['postedByName']),
      deepGet(ad, ['ownerName']),
      deepGet(ad, ['contactName']),
    ),
    email: coalesce(
      deepGet(userObj, ['email']),
      deepGet(userObj, ['emailId']),
      deepGet(ad, ['email']),
      deepGet(ad, ['contactEmail']),
    ),
    phone: coalesce(
      deepGet(userObj, ['phone']),
      deepGet(userObj, ['mobile']),
      deepGet(userObj, ['phoneNumber']),
      deepGet(ad, ['phone']),
      deepGet(ad, ['mobile']),
      deepGet(ad, ['contactPhone']),
    ),
    role: coalesce(
      deepGet(userObj, ['role']),
      deepGet(userObj, ['userType']),
      deepGet(ad, ['postedByRole']),
    ),
    uid: coalesce(
      deepGet(userObj, ['uid']),
      deepGet(userObj, ['userId']),
      deepGet(userObj, ['id']),
      deepGet(ad, ['userId']),
      deepGet(ad, ['postedById']),
    ),
    business: coalesce(
      deepGet(userObj, ['business']),
      deepGet(userObj, ['businessName']),
      deepGet(userObj, ['company']),
    ),
    verificationStatus: coalesce(
      deepGet(userObj, ['verificationStatus']),
      deepGet(userObj, ['verified']),
      deepGet(userObj, ['isVerified']),
      deepGet(ad, ['isVerified']),
    ),
    profilePhoto: coalesce(
      deepGet(userObj, ['profilePhoto']),
      deepGet(userObj, ['photoUrl']),
      deepGet(userObj, ['avatar']),
      deepGet(userObj, ['picture']),
    ),
    memberSince: coalesce(
      deepGet(userObj, ['memberSince']),
      deepGet(userObj, ['createdAt']),
      deepGet(userObj, ['joinedAt']),
    ),
    _raw: userObj,
  };
}

// ─── I. Payment ──────────────────────────────────────────────────────────────

function extractPayment(ad, raw) {
  const pay = coalesce(deepGet(ad, ['payment']), deepGet(ad, ['paymentInfo']), deepGet(ad, ['orderInfo']), {});
  const payObj = typeof pay === 'object' ? pay : {};

  return {
    paymentId: coalesce(deepGet(payObj, ['paymentId']), deepGet(ad, ['paymentId'])),
    orderId: coalesce(deepGet(payObj, ['orderId']), deepGet(ad, ['orderId'])),
    planId: coalesce(deepGet(payObj, ['planId']), deepGet(ad, ['planId'])),
    planName: coalesce(deepGet(payObj, ['planName']), deepGet(ad, ['planName'])),
    paidAmount: coalesce(deepGet(payObj, ['paidAmount']), deepGet(payObj, ['amount']), deepGet(ad, ['paidAmount'])),
    paidAt: coalesce(deepGet(payObj, ['paidAt']), deepGet(payObj, ['paymentDate']), deepGet(ad, ['paidAt'])),
    paymentMethod: coalesce(deepGet(payObj, ['paymentMethod']), deepGet(payObj, ['method'])),
    promoCode: coalesce(deepGet(payObj, ['promoCode']), deepGet(payObj, ['coupon']), deepGet(ad, ['promoCode'])),
    durationDays: coalesce(deepGet(payObj, ['durationDays']), deepGet(payObj, ['duration']), deepGet(ad, ['durationDays'])),
    _raw: payObj,
  };
}

// ─── J. Metadata ─────────────────────────────────────────────────────────────

function extractMetadata(ad, raw, $, url) {
  return {
    adActiveDate: coalesce(
      deepGet(ad, ['activeDate']),
      deepGet(ad, ['postedDate']),
      deepGet(ad, ['createdAt']),
      deepGet(ad, ['publishedAt']),
    ),
    adExpiryDate: coalesce(
      deepGet(ad, ['expiryDate']),
      deepGet(ad, ['expDate']),
      deepGet(ad, ['validTill']),
    ),
    adExpiryStatus: coalesce(
      deepGet(ad, ['expiryStatus']),
      deepGet(ad, ['expired']),
      deepGet(ad, ['isExpired']),
    ),
    category: coalesce(
      deepGet(ad, ['category']),
      deepGet(ad, ['adCategory']),
      deepGet(raw, ['query', 'category']),
    ),
    intent: coalesce(deepGet(ad, ['intent']), deepGet(ad, ['adIntent']), 'rent'),
    status: coalesce(deepGet(ad, ['status']), deepGet(ad, ['adStatus']), deepGet(ad, ['isActive'])),
    createdAt: coalesce(deepGet(ad, ['createdAt']), deepGet(ad, ['dateCreated']), deepGet(ad, ['postedDate'])),
    updatedAt: coalesce(deepGet(ad, ['updatedAt']), deepGet(ad, ['lastModified']), deepGet(ad, ['modifiedAt'])),
    timezone: coalesce(deepGet(ad, ['timezone']), deepGet(ad, ['timeZone']), deepGet(raw, ['locale'])),
    pageUrl: url,
    ogTitle: getAttr($, ['meta[property="og:title"]'], 'content'),
    ogDescription: getAttr($, ['meta[property="og:description"]'], 'content'),
    ogImage: getAttr($, ['meta[property="og:image"]'], 'content'),
    canonicalUrl: getAttr($, ['link[rel="canonical"]'], 'href'),
  };
}

// ─── K. Privacy Settings ─────────────────────────────────────────────────────

function extractPrivacy(ad, raw) {
  const priv = coalesce(deepGet(ad, ['privacy']), deepGet(ad, ['settings']), deepGet(ad, ['visibilitySettings']), {});
  const privObj = typeof priv === 'object' ? priv : {};

  return {
    hidePhone: coalesce(deepGet(privObj, ['hidePhone']), deepGet(ad, ['hidePhone']), deepGet(ad, ['maskPhone'])),
    hideEmail: coalesce(deepGet(privObj, ['hideEmail']), deepGet(ad, ['hideEmail']), deepGet(ad, ['maskEmail'])),
    hideAddress: coalesce(deepGet(privObj, ['hideAddress']), deepGet(ad, ['hideAddress'])),
    whatsappEnabled: coalesce(
      deepGet(privObj, ['whatsappEnabled']),
      deepGet(ad, ['whatsappEnabled']),
      deepGet(ad, ['whatsapp']),
    ),
    mapVisibility: coalesce(
      deepGet(privObj, ['mapVisibility']),
      deepGet(ad, ['mapVisibility']),
      deepGet(ad, ['showMap']),
    ),
    _raw: privObj,
  };
}

// ─── L. Structured Data (LD+JSON) section ────────────────────────────────────

function extractStructuredDataSection(raw, $) {
  const items = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).text().trim();
    const parsed = safeJsonParse(text);
    if (parsed) items.push(parsed);
  });
  return items;
}

// ─── Dynamic field extractor (for future-proofing _extra) ────────────────────

/**
 * Return all top-level keys of `obj` that are NOT in `knownKeys`.
 * Preserves nested structure.
 */
function extractDynamicFields(obj, knownKeys = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const known = new Set(knownKeys);
  const extra = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!known.has(k)) extra[k] = v;
  }
  return extra;
}

// ─── Extract adId from multiple sources ─────────────────────────────────────

function extractAdId(url, adNode, raw) {
  return coalesce(
    deepGet(adNode, ['adId']),
    deepGet(adNode, ['id']),
    deepGet(adNode, ['listingId']),
    deepGet(raw, ['query', 'adId']),
    deepGet(raw, ['query', 'id']),
    extractAdIdFromUrl(url),
  );
}

// ─── Live DOM Extraction (Playwright page) ───────────────────────────────────

/**
 * Extract fields directly from the rendered DOM via page.evaluate().
 * This captures browser-rendered text (innerText), lazy-loaded images, and
 * visible metadata that cheerio (static HTML) cannot see.
 *
 * @param {import('playwright').Page} page
 * @returns {{ overview: string|null, postedBy: string|null, photos: string[] }}
 */
async function extractLiveDom(page) {
  return page.evaluate(() => {
    // ── Overview: preserve rendered line breaks via innerText ──────────────
    let overview = null;
    const overviewSelectors = [
      '[class*="description"]',
      '[class*="overview"]',
      '[class*="ad-detail"]',
      '[class*="listing-description"]',
      '[class*="property-description"]',
      '[itemprop="description"]',
      '.ad-description',
      '.description',
    ];
    for (const sel of overviewSelectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 20) {
        overview = el.innerText.trim();
        break;
      }
    }

    // ── Posted By: look for visible "Posted by" label in DOM ──────────────
    let postedBy = null;
    const postedByRegex = /Posted\s+by[:\s]+(.+)/i;

    // Strategy 1: Search all text-containing elements for "Posted by" label
    const bodyText = document.body.innerText || '';
    const postedByMatch = bodyText.match(postedByRegex);
    if (postedByMatch) {
      postedBy = postedByMatch[1].trim();
    }

    // Strategy 2: Look in info tables / metadata footer sections
    if (!postedBy) {
      const infoSelectors = [
        '[class*="info"]',
        '[class*="meta"]',
        '[class*="footer"]',
        '[class*="detail"]',
        '[class*="overview"]',
        'table',
        '[class*="posted"]',
      ];
      for (const sel of infoSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const txt = (el.innerText || '').trim();
          const m = txt.match(postedByRegex);
          if (m) {
            postedBy = m[1].trim();
            break;
          }
        }
        if (postedBy) break;
      }
    }

    // Strategy 3: Look for label-value pairs (span/label + sibling value)
    if (!postedBy) {
      const labels = document.querySelectorAll('span, label, div, p, td, th, li');
      for (const label of labels) {
        const txt = (label.textContent || '').trim();
        if (/^posted\s+by[:\s]*$/i.test(txt)) {
          // Value is in next sibling or next element
          const next = label.nextElementSibling;
          if (next) {
            postedBy = (next.innerText || next.textContent || '').trim();
          }
          if (!postedBy && label.nextSibling) {
            postedBy = (label.nextSibling.textContent || '').trim();
          }
          if (postedBy) break;
        }
      }
    }

    // ── Photos: extract only from the primary property gallery ────────────
    const photos = [];
    const seenPhotoUrls = new Set();

    function addPhoto(url) {
      if (!url || url.startsWith('data:') || seenPhotoUrls.has(url)) return;
      seenPhotoUrls.add(url);
      photos.push(url);
    }

    function isAdPhoto(url, alt, el) {
      if (!url || url.startsWith('data:')) return false;
      // Reject tiny images
      const w = el.naturalWidth || el.width || parseInt(el.getAttribute('width'), 10) || 0;
      const h = el.naturalHeight || el.height || parseInt(el.getAttribute('height'), 10) || 0;
      if (w > 0 && w < 80) return false;
      if (h > 0 && h < 80) return false;
      // Reject non-property asset patterns
      if (/logo|icon|banner|ad[_-]?img|sponsor|avatar|profile|badge|star|rating|pixel|tracker/i.test(url)) return false;
      if (alt && /logo|icon|banner|ad\b|sponsor/i.test(alt)) return false;
      return true;
    }

    // Sections that contain related/other listings — skip images found inside these
    const EXCLUDED_SELECTORS = [
      '[class*="similar"]', '[class*="related"]', '[class*="explore"]',
      '[class*="nearby"]', '[class*="browse"]', '[class*="recommend"]',
      '[class*="sponsor"]', '[class*="advertisement"]',
      '[class*="other-listing"]', '[class*="more-listing"]',
    ];
    const excludedRoots = EXCLUDED_SELECTORS
      .flatMap(sel => [...document.querySelectorAll(sel)]);

    function isInExcludedSection(el) {
      return excludedRoots.some(root => root.contains(el));
    }

    // Strategy 1: PRIMARY gallery only — the first matching container NOT inside
    // an excluded section. We stop as soon as we find images, so related-listing
    // carousels lower on the page are never reached.
    // #photoDiv / .roomimageblock are Sulekha's own gallery IDs (highest priority).
    const primaryGallerySelectors = [
      '#photoDiv',
      '.roomimageblock',
      '[class*="photo-gallery"]',
      '[class*="listing-photo"]',
      '[class*="property-photo"]',
      '[class*="image-gallery"]',
      '[class*="gallery"]',
      '[class*="carousel"]',
      '[class*="slider"]',
      '[class*="swiper"]',
      '[class*="lightbox"]',
      '[class*="media"]',
    ];

    for (const sel of primaryGallerySelectors) {
      const containers = [...document.querySelectorAll(sel)];
      const primaryContainer = containers.find(c => !isInExcludedSection(c));
      if (!primaryContainer) continue;

      let added = 0;
      for (const img of primaryContainer.querySelectorAll('img')) {
        if (isInExcludedSection(img)) continue;
        const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || '';
        if (isAdPhoto(src, img.alt || '', img)) { addPhoto(src); added++; }

        // If this img is wrapped in an <a>, also capture the href as full-size URL.
        // Scoped to this container so we only get the current ad's photos.
        const parentA = img.closest('a');
        if (parentA) {
          const href = (parentA.getAttribute('href') || '').trim();
          if (href && !href.startsWith('javascript:') && !href.startsWith('#') && href !== '') {
            if (isAdPhoto(href, '', img)) { addPhoto(href); }
          }
        }
      }
      // Background images inside same container
      for (const el of primaryContainer.querySelectorAll('[style*="background-image"]')) {
        if (isInExcludedSection(el)) continue;
        const m = (el.getAttribute('style') || '').match(/url\(['"]?([^'")\s]+)['"]?\)/);
        if (m && m[1]) { addPhoto(m[1]); added++; }
      }

      if (added > 0) break; // found the primary gallery, stop here
    }

    // og:image is intentionally skipped — Sulekha sets it to the site logo, not the ad photo.

    // Strategy 2: JSON-LD image field (structured data for THIS page only)
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of ldScripts) {
      try {
        const data = JSON.parse(script.textContent);
        const images = data.image || (data['@graph'] || []).flatMap(g => g.image || []);
        for (const img of (Array.isArray(images) ? images : [images])) {
          if (typeof img === 'string') addPhoto(img);
          else if (img && img.url) addPhoto(img.url);
        }
      } catch {}
    }

    return { overview, postedBy, photos };
  });
}

/**
 * Merge DOM-extracted fields into the ad record.
 * Only overrides JSON-extracted fields when the JSON value is "not_found" or missing.
 * Includes defensive null checks to prevent crashes if sub-objects are undefined.
 */
function mergeDomIntoRecord(adRecord, domData) {
  if (!domData) return;

  // Ensure required sub-objects exist on adRecord before merging
  if (!adRecord.description || typeof adRecord.description !== 'object') {
    adRecord.description = {};
  }
  if (!adRecord.poster || typeof adRecord.poster !== 'object') {
    adRecord.poster = {};
  }
  if (!adRecord.photos || typeof adRecord.photos !== 'object') {
    adRecord.photos = { count: 0, items: [] };
  }

  // ── Overview (description.fullDescription) ──────────────────────────────
  if (domData.overview) {
    const current = adRecord.description.fullDescription;
    if (!current || current === 'not_found' || (typeof current === 'string' && current.trim() === '')) {
      adRecord.description.fullDescription = domData.overview;
      log.info('[EXTRACT] DOM overview extracted (overriding JSON).');
    } else if (typeof current === 'string') {
      // If JSON description is flat (no line breaks) but DOM has formatting, prefer DOM
      const hasLineBreaks = domData.overview.includes('\n');
      const jsonIsFlat = !current.includes('\n');
      if (hasLineBreaks && jsonIsFlat && domData.overview.length >= current.length * 0.7) {
        adRecord.description.fullDescription = domData.overview;
        log.info('[EXTRACT] DOM overview used (preserves formatting better than JSON).');
      } else {
        log.info('[EXTRACT] DOM overview extracted but JSON value kept (JSON is richer).');
      }
    }
  } else {
    log.debug('[EXTRACT] DOM overview not found in visible DOM.');
  }

  // ── Posted By (poster.displayName) ───────────────────────────────────────
  if (domData.postedBy) {
    const current = adRecord.poster.displayName;
    if (!current || current === 'not_found' || (typeof current === 'string' && current.trim() === '')) {
      adRecord.poster.displayName = domData.postedBy;
      log.info(`[EXTRACT] DOM postedBy extracted: "${domData.postedBy}"`);
    } else {
      log.info(`[EXTRACT] DOM postedBy extracted but JSON has value ("${current}"), keeping JSON.`);
    }
  } else {
    log.debug('[EXTRACT] DOM postedBy not found in visible DOM.');
  }

  // ── Photos ───────────────────────────────────────────────────────────────
  if (domData.photos && domData.photos.length) {
    const currentPhotos = Array.isArray(adRecord.photos?.items) ? adRecord.photos.items : [];
    if (!currentPhotos.length) {
      // JSON had no photos — use DOM photos
      adRecord.photos = {
        count: domData.photos.length,
        items: domData.photos.map((url, idx) => ({
          index: idx,
          url,
          alt: null,
          metadata: null,
        })),
      };
      log.info(`[EXTRACT] DOM photos extracted: ${domData.photos.length} images.`);
    } else {
      // Merge: add any DOM photos not already present in JSON
      const existingUrls = new Set(currentPhotos.map(p => p.url).filter(Boolean));
      const newPhotos = domData.photos.filter(u => !existingUrls.has(u));
      if (newPhotos.length) {
        const merged = [...currentPhotos];
        for (const url of newPhotos) {
          merged.push({
            index: merged.length,
            url,
            alt: null,
            metadata: null,
          });
        }
        adRecord.photos = { count: merged.length, items: merged };
        log.info(`[EXTRACT] DOM photos merged: +${newPhotos.length} new (total ${merged.length}).`);
      } else {
        log.info(`[EXTRACT] DOM photos extracted but all already present in JSON.`);
      }
    }
  } else {
    log.debug('[EXTRACT] DOM photos: no images found in gallery/DOM.');
  }
}

// ─── Listing Page Extractor ──────────────────────────────────────────────────

/**
 * Extract all detail page URLs from a listing/pagination page.
 * Also extracts next-page URL if available.
 *
 * @param {string} html - Page HTML
 * @param {string} pageUrl - Current page URL
 * @returns {{ detailUrls: string[], nextPageUrl: string|null, totalCount: number|null }}
 */
export function extractListingPage(html, pageUrl) {
  const $ = cheerioLoad(html);
  const detailUrls = new Set();
  let nextPageUrl = null;
  let totalCount = null;

  // Extract all anchor hrefs
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    let absoluteUrl;
    try {
      absoluteUrl = new URL(href, pageUrl).toString();
    } catch {
      return;
    }

    // Match detail page pattern
    if (/\/[^/]+_rentals_[^/]+_\d+\/?$/.test(new URL(absoluteUrl).pathname)) {
      detailUrls.add(absoluteUrl.split('?')[0].split('#')[0]);
    }
  });

  // Detect next page URL
  // Common patterns: rel=next, "Next", pagination links with page=N
  const nextEl = $('a[rel="next"], a:contains("Next"), a:contains("»"), [class*="next"] a, [class*="pagination"] a').filter((_, el) => {
    const href = $(el).attr('href');
    return !!href && href !== '#';
  }).first();

  if (nextEl.length) {
    try {
      const href = nextEl.attr('href');
      nextPageUrl = new URL(href, pageUrl).toString();
      // Sanity check - must be same domain
      if (!new URL(nextPageUrl).hostname.includes('sulekha.com')) nextPageUrl = null;
    } catch {
      nextPageUrl = null;
    }
  }

  // Try extracting from __NEXT_DATA__ for pagination
  try {
    const nextData = extractNextData($, html);
    if (nextData) {
      const pageProps = deepGet(nextData, ['props', 'pageProps']);
      // Look for total count
      const tc = coalesce(
        deepGet(pageProps, ['totalCount']),
        deepGet(pageProps, ['total']),
        deepGet(pageProps, ['totalAds']),
        deepGet(pageProps, ['count']),
      );
      if (tc !== null && tc !== undefined) totalCount = Number(tc);

      // Look for next page info
      const nextPage = coalesce(
        deepGet(pageProps, ['nextPage']),
        deepGet(pageProps, ['pagination', 'nextPage']),
        deepGet(pageProps, ['pagination', 'next']),
      );
      if (nextPage && typeof nextPage === 'string' && !nextPageUrl) {
        try {
          nextPageUrl = new URL(nextPage, pageUrl).toString();
        } catch {}
      }

      // Extract inline listing URLs from Next.js data
      const listings = coalesce(
        deepGet(pageProps, ['listings']),
        deepGet(pageProps, ['ads']),
        deepGet(pageProps, ['results']),
        deepGet(pageProps, ['data']),
      );
      if (Array.isArray(listings)) {
        for (const listing of listings) {
          if (!listing) continue;
          const slug = coalesce(listing.slug, listing.url, listing.listingUrl, listing.canonicalUrl);
          const id = coalesce(listing.adId, listing.id, listing.listingId);
          if (slug) {
            try {
              const absolute = new URL(slug, pageUrl).toString();
              if (/\/[^/]+_rentals_[^/]+_\d+\/?$/.test(new URL(absolute).pathname)) {
                detailUrls.add(absolute.split('?')[0]);
              }
            } catch {}
          } else if (id) {
            // Cannot build URL without slug, skip
          }
        }
        if (!totalCount) totalCount = listings.length;
      }
    }
  } catch (err) {
    log.debug(`extractListingPage: Next.js extraction error: ${err.message}`);
  }

  return {
    detailUrls: [...detailUrls],
    nextPageUrl,
    totalCount,
  };
}

// ─── SCRAPPED_AD_DETAILS Extractor ──────────────────────────────────────────

/**
 * Extract a clean, flat SCRAPPED_AD_DETAILS object from the rendered detail page.
 * All fields default to null / [] so the schema is always consistent.
 *
 * @param {Object} params
 * @param {string}  params.url   - Full ad detail URL
 * @param {string}  params.html  - Raw page HTML (already fetched in handleDetail)
 * @param {Object}  [params.page]- Playwright page object for live DOM extraction
 */
export async function extractScrapedAdDetails({ url, html, page }) {
  const adId = extractAdIdFromUrl(url);
  const scrapedAt = new Date().toISOString();

  const result = {
    adId,
    sourceUrl: url,
    title: null,
    breadcrumb: [],
    adType: null,
    propertyCategory: null,
    bedrooms: null,
    bathrooms: null,
    areaSqft: null,
    availableFrom: null,
    rent: null,
    rentCurrency: 'USD',
    deposit: null,
    accommodates: null,
    roomType: null,
    stayType: null,
    accommodationType: null,
    couplesAllowed: null,
    postedBy: null,
    postedOn: null,
    adIdOnSite: adId,
    description: null,
    address: {
      fullAddress: null,
      city: null,
      state: null,
      zipcode: null,
      county: null,
      nearbyUniversity: null,
      nearbyNeighborhoods: [],
    },
    amenities: [],
    utilities: [],
    additionalInfo: {
      smoking: null,
      vegNonVeg: null,
      pets: null,
      furnishing: null,
    },
    tenantPreferences: {
      alcohol: null,
      occupation: null,
      genderPreference: null,
      ageRange: null,
    },
    verifiedCredentials: [],
    photos: [],
    photoCount: 0,
    contactInfo: {
      phone: null,
      email: null,
    },
    scrapedAt,
  };

  if (!page) {
    log.warning('[SCRAPPED_AD_DETAILS] No Playwright page — returning base record.');
    return result;
  }

  try {
    const d = await page.evaluate(() => {
      // ── DOM helpers ────────────────────────────────────────────────────────
      const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';

      const getText = (sel, root = document) => {
        const el = root.querySelector(sel);
        return el ? (el.innerText || el.textContent || '').trim() || null : null;
      };

      // ── Detail grid label → value extraction ──────────────────────────────
      // Handles parent-child, sibling, and label/value class patterns.
      const LABEL_MAP = {
        'ad type': 'adType', 'property': 'propertyCategory',
        'bedrooms': 'bedrooms', 'bathrooms': 'bathrooms',
        'area': 'areaSqft', 'available from': 'availableFrom',
        'expected rent': 'rent', 'rent': 'rent', 'price': 'rent',
        'accommodates': 'accommodates', 'posted by': 'postedBy',
        'room type': 'roomType', 'stay type': 'stayType',
        'accommodation type': 'accommodationType',
        'deposit': 'deposit', 'couples allowed': 'couplesAllowed',
      };

      const extractGrid = () => {
        const pairs = {};
        const candidates = [...document.querySelectorAll('span, p, div, label, td, th, dt, h5, h6, small')];
        for (const el of candidates) {
          const rawTxt = (el.innerText || el.textContent || '').trim();
          if (!rawTxt || rawTxt.length > 60) continue;
          const key = LABEL_MAP[rawTxt.toLowerCase().replace(/:$/, '').trim()];
          if (!key || pairs[key]) continue;

          let val = null;
          // Strategy 1: direct next element sibling
          const sib = el.nextElementSibling;
          if (sib) {
            const t = (sib.innerText || sib.textContent || '').trim();
            if (t && t.length < 200 && !LABEL_MAP[t.toLowerCase()]) val = t;
          }
          // Strategy 2: parent cell → next cell
          if (!val) {
            const cell = el.closest('td, [class*="col"], [class*="cell"], [class*="field"], [class*="detail-item"]');
            if (cell) {
              const nextCell = cell.nextElementSibling;
              if (nextCell) val = (nextCell.innerText || nextCell.textContent || '').trim() || null;
            }
          }
          // Strategy 3: parent → next sibling
          if (!val) {
            const parent = el.parentElement;
            const next = parent?.nextElementSibling;
            if (next) {
              const t = (next.innerText || next.textContent || '').trim();
              if (t && t.length < 200 && !LABEL_MAP[t.toLowerCase()]) val = t;
            }
          }
          if (val) pairs[key] = val;
        }
        return pairs;
      };

      // ── Section items extractor ────────────────────────────────────────────
      // Finds a section by its heading text, returns array of item label strings.
      const extractSection = (headingPattern) => {
        const headings = [...document.querySelectorAll(
          'h2, h3, h4, h5, b, strong, [class*="section-title"], [class*="section-heading"], [class*="heading"]'
        )];
        const heading = headings.find(h => {
          const t = (h.innerText || h.textContent || '').trim();
          return headingPattern.test(t) && t.length < 60;
        });
        if (!heading) return [];

        let container = heading.nextElementSibling;
        if (!container || container.children.length === 0) {
          const parent = heading.parentElement;
          container = parent?.nextElementSibling || parent;
        }
        if (!container) return [];

        const seen = new Set();
        const items = [];
        const tryEls = container.querySelectorAll(
          '[class*="item"], [class*="tag"], [class*="badge"], [class*="chip"], [class*="feature"], [class*="amenity"], li'
        );
        const src = tryEls.length > 0 ? [...tryEls] : [...container.children];
        for (const el of src) {
          const t = (el.innerText || el.textContent || '').trim();
          if (t && t.length >= 2 && t.length <= 80 && !seen.has(t) && !headingPattern.test(t)) {
            seen.add(t);
            items.push(t);
          }
        }
        return items;
      };

      // ── Title & Breadcrumb ────────────────────────────────────────────────
      const title = getText('h1') || getText('[class*="ad-title"]') || getText('[class*="listing-title"]');

      const breadcrumb = [...document.querySelectorAll(
        '[class*="breadcrumb"] a, [class*="breadcrumb"] span, nav ol li a, nav ol li span, [aria-label="breadcrumb"] a'
      )].map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean);

      // ── Detail grid ───────────────────────────────────────────────────────
      const grid = extractGrid();

      // ── Posted metadata line ──────────────────────────────────────────────
      // "Posted on: Jun 05, 2026 | AD ID: 1565512 | Posted by: Fatima"
      const postedOnMatch = bodyText.match(/Posted\s+on[:\s]+([A-Za-z]+\.?\s+\d{1,2},?\s*\d{4})/i);
      const postedOn = postedOnMatch ? postedOnMatch[1].trim() : null;

      const adIdOnSiteMatch = bodyText.match(/AD\s+ID[:\s#]+(\d+)/i);
      const adIdOnSite = adIdOnSiteMatch ? adIdOnSiteMatch[1] : null;

      const postedByTextMatch = bodyText.match(/Posted\s+by[:\s]+([^\n|<]{2,60}?)(?:\s*\||\n|$)/i);
      const postedByFromText = postedByTextMatch ? postedByTextMatch[1].trim() : null;

      // ── Address parsing ───────────────────────────────────────────────────
      // Under the h1 title: "Jersey City, NJ, USA, 07302 | Hudson County | ..."
      let fullAddress = null, city = null, state = null, zipcode = null,
          county = null, nearbyUniversity = null;
      const nearbyNeighborhoods = [];

      const h1 = document.querySelector('h1');
      if (h1) {
        let sib = h1.nextElementSibling;
        for (let i = 0; i < 5 && sib; i++) {
          const t = (sib.innerText || sib.textContent || '').trim();
          // Match both "City, ST," patterns and street-first addresses like "123 Main St, City, ST,"
          if (/,\s*[A-Z]{2}[,\s]/.test(t) || /\b\d{5}\b/.test(t)) {
            // fullAddress: everything up to the first pipe or "View on Map" keyword
            fullAddress = t.split(/\s*\|\s*/)[0].replace(/\s*View on Map.*/i, '').trim();
            // City: shortest letter-sequence directly before ", StateCode,"
            const csMatch = t.match(/([A-Za-z][A-Za-z ]{1,35}?),\s*([A-Z]{2})(?:[,\s]|$)/);
            if (csMatch) {
              // If match includes comma (e.g. "Street, City") take the last segment
              const segments = csMatch[1].trim().split(',');
              city  = segments[segments.length - 1].trim();
              state = csMatch[2];
            }
            const zipMatch = t.match(/\b(\d{5})\b/);
            if (zipMatch) zipcode = zipMatch[1];
            const countyMatch = t.match(/\b([A-Z][a-zA-Z]+(?:\s+[A-Za-z]+)*\s+County)\b/);
            if (countyMatch) county = countyMatch[1].trim();
            const uniMatch = t.match(/(?:University|College)[^:]*?(?:from|:)\s*([^|\n,]{3,60})/i);
            if (uniMatch) nearbyUniversity = uniMatch[1].trim();
            break;
          }
          sib = sib.nextElementSibling;
        }
      }
      if (!fullAddress) fullAddress = getText('[itemprop="address"]') || getText('[class*="address"]');

      // Nearby neighborhoods: from dedicated elements or a text pattern
      [...document.querySelectorAll('[class*="neighborhood"] a, [class*="nearby-neighborhood"] a')].forEach(el => {
        const t = (el.innerText || el.textContent || '').trim();
        if (t && !nearbyNeighborhoods.includes(t)) nearbyNeighborhoods.push(t);
      });
      if (!nearbyNeighborhoods.length) {
        const nbMatch = bodyText.match(/Nearby\s+Neighborhood[s]?[:\s]+([^\n]+)/i);
        if (nbMatch) nearbyNeighborhoods.push(...nbMatch[1].split(/[,|]/).map(s => s.trim()).filter(Boolean));
      }

      // ── Overview / Description ────────────────────────────────────────────
      let description = null;
      for (const sel of [
        '[class*="overview-content"]', '[class*="overview"] > p', '[class*="description-content"]',
        '[class*="ad-description"]', '[class*="description"]', '[itemprop="description"]',
      ]) {
        const el = document.querySelector(sel);
        if (el && (el.innerText || '').trim().length > 30) {
          description = (el.innerText || el.textContent || '').trim(); break;
        }
      }
      if (!description) {
        const oh = [...document.querySelectorAll('h2, h3, h4')].find(h =>
          /^overview$/i.test((h.innerText || h.textContent || '').trim())
        );
        if (oh?.nextElementSibling) description = (oh.nextElementSibling.innerText || '').trim() || null;
      }

      // ── Section arrays ────────────────────────────────────────────────────
      const amenities = extractSection(/^amenities$/i);
      const utilities = extractSection(/^utilities$/i);

      const addInfoItems = extractSection(/^additional\s+info/i);
      const additionalInfo = { smoking: null, vegNonVeg: null, pets: null, furnishing: null };
      for (const t of addInfoItems) {
        if (/smoking/i.test(t))               additionalInfo.smoking    = t;
        else if (/veg/i.test(t))              additionalInfo.vegNonVeg  = t;
        else if (/pet/i.test(t))              additionalInfo.pets       = t;
        else if (/furnished|furnish/i.test(t)) additionalInfo.furnishing = t;
      }

      const prefItems = extractSection(/^tenant\s+pref/i);
      const tenantPreferences = { alcohol: null, occupation: null, genderPreference: null, ageRange: null };
      for (const t of prefItems) {
        if (/alcohol/i.test(t))                          tenantPreferences.alcohol          = t;
        else if (/occupation|mind|prefer|student/i.test(t)) tenantPreferences.occupation    = t;
        else if (/male|female|any.*gender/i.test(t))     tenantPreferences.genderPreference = t;
        else if (/\d+\s+to\s+\d+|age/i.test(t))         tenantPreferences.ageRange         = t;
      }

      const verifiedItems = extractSection(/^verified\s+credential/i);
      const verifiedCredentials = verifiedItems.filter(t => /verified/i.test(t));
      if (!verifiedCredentials.length) {
        const vm = bodyText.match(/(?:Phone|Mail|Email|Identity|Address)\s+Verified/gi) || [];
        verifiedCredentials.push(...[...new Set(vm)]);
      }

      // ── Photos: extract ONLY from #photoDiv / .roomimageblock ───────────────
      //
      // Sulekha DOM inside #photoDiv:
      //   div.roomimagelt
      //     └─ figure#mainphoto
      //          └─ a[onclick="showAdPhoto(...)"]
      //               └─ img[itemprop="photo"][src="https://usimg.sulekha.io/..."]
      //   div#singleAdthumbImgContainer.roomimagert
      //     └─ figure.roomimagesplt  (one or more thumbnails)
      //          └─ a[onclick="showAdPhoto(...)"]
      //               ├─ img[src="https://usimg.sulekha.io/..."]   ← thumbnail URL
      //               └─ figcaption ("4 more photos")              ← may or may not be present
      //
      // We must capture ALL img[src] from every figure inside #photoDiv —
      // including those where a figcaption overlay is present.
      // We do NOT use og:image because Sulekha sets it to the site logo.

      const photos = [];
      const seenPhotoUrls = new Set();

      // Reject non-photo assets (logos, icons, spinners, placeholders)
      const isRejectedSrc = (src) =>
        !src || src.startsWith('data:') ||
        /logo|icon|spinner|placeholder|blank\.gif|pixel|1x1|transparent/i.test(src);

      const addPhoto = (src) => {
        if (!isRejectedSrc(src) && !seenPhotoUrls.has(src)) {
          seenPhotoUrls.add(src);
          photos.push(src);
        }
      };

      // Strategy 1: #photoDiv — authoritative Sulekha gallery container
      const photoDiv = document.getElementById('photoDiv') || document.querySelector('.roomimageblock');
      if (photoDiv) {
        // Pass A: img[itemprop="photo"] — Sulekha marks main property photos with this
        for (const img of photoDiv.querySelectorAll('img[itemprop="photo"]')) {
          addPhoto(img.getAttribute('src') || img.getAttribute('data-src') || '');
        }

        // Pass B: ALL figure img — catches thumbnails (roomimagesplt) INCLUDING those
        // that have a <figcaption> sibling ("4 more photos" overlay).
        // data-src used for lazy-loaded thumbnails that haven't loaded yet.
        // Also checks the parent <a> href — on some Sulekha layouts the <a>
        // links to the full-size image while img.src is only the thumbnail.
        for (const img of photoDiv.querySelectorAll('figure img')) {
          const src =
            img.getAttribute('src') ||
            img.getAttribute('data-src') ||
            img.getAttribute('data-lazy-src') ||
            img.getAttribute('data-original') || '';
          addPhoto(src);

          // If this img is wrapped in an <a>, capture the href as the full-size URL
          const parentA = img.closest('a');
          if (parentA) {
            const href = (parentA.getAttribute('href') || '').trim();
            if (href && !href.startsWith('javascript:') && !href.startsWith('#') && href !== '') {
              addPhoto(href);
            }
          }
        }
      }

      // Strategy 1b: Capture additional photos loaded by showAdPhoto().
      // showAdPhoto() was clicked in routes.js before this function was called, so the
      // gallery modal (which contains ONLY this ad's photos) should be open in the live DOM.
      // We target the modal specifically — NOT the whole page — to avoid picking up
      // related-listing or similar-listing photos from other sections.
      {
        const sulekhaRentalsPath = 'usimg.sulekha.io/cdn/rentals/images/';

        // 1. <a href> inside #photoDiv — some Sulekha themes link full-size photo URLs
        if (photoDiv) {
          for (const a of photoDiv.querySelectorAll('a')) {
            const href = a.getAttribute('href') || '';
            if (href.includes(sulekhaRentalsPath)) addPhoto(href);
          }
        }

        // 2. Gallery / lightbox overlay opened by showAdPhoto().
        //    We search common gallery library selectors and only accept
        //    images from the Sulekha rentals CDN to avoid false positives.
        const gallerySelectors = [
          // Fancybox (very common on jQuery sites)
          '#fancybox-inner', '.fancybox-inner',
          '#fancybox-wrap', '.fancybox-wrap',
          '.fancybox-container', '.fancybox-slide',
          // Lightbox2
          '#lightbox', '.lightbox',
          // PhotoSwipe
          '.pswp', '.pswp__item',
          // Generic popup / overlay patterns
          '[class*="gallery-popup"]', '[class*="photo-popup"]',
          '[class*="gallery-modal"]', '[class*="photo-modal"]',
          '[class*="image-viewer"]', '[class*="photo-viewer"]',
          '[class*="carousel-inner"]',
          // Bootstrap modal when open
          '.modal.show', '.modal.in',
        ];
        for (const sel of gallerySelectors) {
          try {
            for (const el of document.querySelectorAll(sel)) {
              const imgs = (el.tagName === 'IMG') ? [el] : el.querySelectorAll('img');
              for (const img of imgs) {
                const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
                if (src.includes(sulekhaRentalsPath)) addPhoto(src);
              }
            }
          } catch {}
        }
      }

      // Strategy 2: generic gallery selectors — only if #photoDiv absent or empty
      if (!photos.length) {
        const excludedRoots = [...document.querySelectorAll(
          '[class*="similar"], [class*="related"], [class*="explore"], [class*="nearby-listing"], [class*="browse"], [class*="recommend"], [class*="sponsor"]'
        )];
        const isExcluded = el => excludedRoots.some(r => r.contains(el));
        for (const sel of [
          '[class*="photo-gallery"]', '[class*="listing-photo"]', '[class*="property-photo"]',
          '[class*="image-gallery"]', '[class*="gallery"]', '[class*="carousel"]', '[class*="swiper"]',
        ]) {
          const container = [...document.querySelectorAll(sel)].find(c => !isExcluded(c));
          if (!container) continue;
          let added = 0;
          for (const img of container.querySelectorAll('img')) {
            if (isExcluded(img)) continue;
            const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || '';
            if (!isRejectedSrc(src) && !seenPhotoUrls.has(src)) {
              seenPhotoUrls.add(src); photos.push(src); added++;
            }
          }
          if (added > 0) break;
        }
      }

      // ── Contact info (site footer / header) ───────────────────────────────
      const phoneMatch = bodyText.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
      const emailMatch = bodyText.match(/[\w.+\-]+@[\w\-]+\.[a-z]{2,}/i);

      return {
        title, breadcrumb, grid, postedOn, adIdOnSite,
        postedBy: grid.postedBy || postedByFromText,
        description,
        address: { fullAddress, city, state, zipcode, county, nearbyUniversity, nearbyNeighborhoods },
        amenities, utilities, additionalInfo, tenantPreferences, verifiedCredentials, photos,
        phone: phoneMatch?.[0] || null,
        email: emailMatch?.[0] || null,
      };
    });

    // ── Merge into result ─────────────────────────────────────────────────────
    const g = d.grid || {};

    result.title              = d.title;
    result.breadcrumb         = d.breadcrumb;
    result.adType             = g.adType             || null;
    result.propertyCategory   = g.propertyCategory   || null;
    result.bedrooms           = g.bedrooms            || null;
    result.bathrooms          = g.bathrooms           || null;
    result.areaSqft           = g.areaSqft ? g.areaSqft.replace(/[^\d.]/g, '') || g.areaSqft : null;
    result.availableFrom      = g.availableFrom       || null;
    result.rent               = g.rent               || null;
    result.deposit            = g.deposit ? g.deposit.replace(/^\$/, '') : null;
    result.accommodates       = g.accommodates        || null;
    result.roomType           = g.roomType            || null;
    result.stayType           = g.stayType            || null;
    result.accommodationType  = g.accommodationType   || null;
    result.couplesAllowed     = g.couplesAllowed      || null;
    result.postedBy           = d.postedBy            || null;
    result.postedOn           = d.postedOn            || null;
    result.adIdOnSite         = d.adIdOnSite          || adId;
    result.description        = d.description         || null;
    result.address = d.address;

    // Fallback: if DOM extraction missed individual fields, parse them from fullAddress
    if (result.address.fullAddress) {
      const parsedAddr = parseSulekhaFullAddress(result.address.fullAddress);
      if (!result.address.city    && parsedAddr.city)      result.address.city    = parsedAddr.city;
      if (!result.address.state   && parsedAddr.state)     result.address.state   = parsedAddr.state;
      if (!result.address.zipcode && parsedAddr.zipCode)   result.address.zipcode = parsedAddr.zipCode;
      if (!result.address.county  && parsedAddr.district)  result.address.county  = parsedAddr.district;
    }

    result.amenities          = d.amenities;
    result.utilities          = d.utilities;
    result.additionalInfo     = d.additionalInfo;
    result.tenantPreferences  = d.tenantPreferences;
    result.verifiedCredentials = d.verifiedCredentials;
    result.photos             = d.photos;
    result.photoCount         = d.photos.length;
    result.contactInfo        = { phone: d.phone, email: d.email };

  } catch (err) {
    log.warning(`[SCRAPPED_AD_DETAILS] Extraction error: ${err.message}`);
  }

  return result;
}
