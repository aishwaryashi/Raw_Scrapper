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
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
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

/**
 * Transform the scraped adData object into the Firestore document structure.
 */
function buildFirestoreDoc(adData) {
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

  // ── Amenity map + derived values ──────────────────────────────────────────
  const amenities  = buildAmenitiesMap(adData);
  const fromKeys   = extractFromAmenityKeys(amenities);

  // ── Effective (merged) scalar values — JSON > SCRAPPED > amenity-derived ──
  const effectiveBaths    = n(prop.baths)        ?? scrBaths   ?? null;
  const effectiveBeds     = n(prop.beds)          ?? scrBeds    ?? fromKeys.beds ?? null;
  const effectiveRent     = n(prop.rentAmount)    ?? scrRent?.amount ?? null;
  const effectiveCurrency = n(prop.rentCurrency)  || scrRent?.currency || 'USD';
  const effectiveMode     = n(prop.rentFrequency) || scrRent?.mode     || 'per_month';
  const effectiveSqFt     = n(prop.squareFeet)    ?? scrArea    ?? fromKeys.squareFeet ?? null;
  // Intent: amenity key wins when present; else metadata; else "list"
  const effectiveIntent   = fromKeys.intent || n(meta.intent) || 'list';
  // Available-from: amenity key can override if not in JSON
  const effectiveAvailFrom = n(avail.availableFrom) || fromKeys.availableFrom || null;

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

  const neighborhoods = (typeof loc.neighborhoods === 'object' && loc.neighborhoods !== null && loc.neighborhoods !== 'not_found')
    ? loc.neighborhoods : {};

  const languages = (typeof prefs.languages === 'object' && prefs.languages !== null && prefs.languages !== 'not_found')
    ? prefs.languages : {};

  return {
    // ── Top-level amenities (key:bool map from DOM + deep extraction) ────────
    amenities,

    // ── Search index ─────────────────────────────────────────────────────────
    _search: {
      adId,
      adactivedate:    n(meta.adActiveDate),
      adexpirydate:    n(meta.adExpiryDate),
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
      metroArea:       (n(loc.metroArea)  || '').toLowerCase(),
      orderId:         n(pay.orderId),
      paymentId:       n(pay.paymentId),
      propertyType:    n(prop.propertyType),
      rent:            effectiveRent,
      state:           (n(loc.state)      || '').toLowerCase(),
      stateCode:       n(loc.stateCode),
      status:          n(meta.status) || 'enable',
      subLocality:     (n(loc.subLocality) || '').toLowerCase(),
      title_lowercase: (n(prop.title)     || '').toLowerCase(),
      userid:          FIXED_USER.uid,
      zipcode:         n(loc.zipCode),
    },

    adId,

    details: {
      amenities: {},          // structured amenities reserved for frontend-posted ads
      availability: {
        daysAvailable: n(avail.daysAvailable),
        from:          effectiveAvailFrom,
        stayType,
        to:            n(avail.availableTo),
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
        metroArea:        n(loc.metroArea),
        neighborhoods,
        showOnMap:        priv.mapVisibility !== false && priv.hideAddress !== true,
        state:            n(loc.state),
        stateCode:        n(loc.stateCode),
        subLocality:      n(loc.subLocality),
        zipcode:          n(loc.zipCode),
      },
    },

    metadata: {
      adactivedate:   n(meta.adActiveDate),
      adexpirydate:   n(meta.adExpiryDate),
      adexpirystatus: n(meta.adExpiryStatus) || 'active',
      adtimezone:     n(meta.timezone) || 'America/New_York',
      category:       n(meta.category) || 'property',
      // Firestore server timestamp — set when the document is first written
      createdAt:      FieldValue.serverTimestamp(),
      intent:         effectiveIntent,
      orderId:        n(pay.orderId),
      paymentId:      n(pay.paymentId),
      role:           FIXED_USER.role,
      status:         n(meta.status) || 'enable',
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
      ageRange:        n(prefs.ageRange),
      alcoholAllowed:  n(prefs.alcoholAllowed),
      couplesWelcome:  n(prefs.couplesWelcome),
      languages,
      occupation:      n(prefs.occupation),
      pets:            n(prefs.pets),
      preferredGender: n(prefs.preferredGender),
      smoking:         n(prefs.smoking),
      vegetarian:      n(prefs.vegetarian),
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

    user: FIXED_USER,
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
      // If the existing document already has geocoded coords, it's a true duplicate.
      const existingLat = existing.data()?.details?.location?.lat;
      if (existingLat != null) {
        log.info(`[FIRESTORE] Ad ${adId} already exists with geocoded data — skipping.`);
        return false;
      }

      // Document exists but lat/lng are null — update location + search fields with newly geocoded data.
      const doc = buildFirestoreDoc(adData);
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
      log.info(`[FIRESTORE] Updated ad ${adId} — backfilled geocoded location fields.`);
      return true;
    }

    const doc = buildFirestoreDoc(adData);
    await docRef.set(doc);
    log.info(`[FIRESTORE] Saved ad ${adId} to "${ADS_COLLECTION}" collection.`);
    return true;
  } catch (err) {
    log.error(`[FIRESTORE] Save failed for ad ${adId}: ${err.message}`);
    return false;
  }
}
