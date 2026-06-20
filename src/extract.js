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
import {
  safeJsonParse,
  deepMerge,
  normalizeMissing,
  extractAdIdFromUrl,
  truncate,
} from './helpers.js';

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

  return {
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

    // Primary gallery containers only — stop at the first one that has images
    const galleryCandidates = [
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
    const primaryGallerySelectors = [
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
      }
      // Background images inside same container
      for (const el of primaryContainer.querySelectorAll('[style*="background-image"]')) {
        if (isInExcludedSection(el)) continue;
        const m = (el.getAttribute('style') || '').match(/url\(['"]?([^'")\s]+)['"]?\)/);
        if (m && m[1]) { addPhoto(m[1]); added++; }
      }

      if (added > 0) break; // found the primary gallery, stop here
    }

    // Strategy 2: og:image — always the main listing photo, safe to include
    const ogImg = document.querySelector('meta[property="og:image"]');
    if (ogImg && ogImg.content) addPhoto(ogImg.content);

    // Strategy 3: JSON-LD image field (structured data for THIS page only)
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
