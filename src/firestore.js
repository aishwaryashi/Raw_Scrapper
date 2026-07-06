/**
 * firestore.js
 * Firebase Admin SDK wrapper for saving scraped ads to Firestore.
 *
 * Collection: `ads`
 * Document ID: adId (string)
 * Dedup: checks whether the document already exists before writing.
 * Fixed user: the Urjaonly account as specified in actor input.
 *
 * Document shape matches schema/ad-output-schema.json:
 *   - metadata.intent = "list"  (ad_type = "Property Offered") → include
 *     propertyDetails + preferences, omit roomDetails/seeker.
 *   - metadata.intent = "find"  (ad_type = "Property Wanted")  → include
 *     roomDetails + seeker, omit propertyDetails/preferences.
 *
 * The pre-migration implementation (nested details.location, no
 * seeker/roomDetails split) is preserved in src/oldschema.js for reference.
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { log } from 'crawlee';

const ADS_COLLECTION = 'ads';
const PROJECT_ID = 'rentalportal-494212';

const FIXED_USER = {
  business: null,
  displayName: 'Urjaonly',
  email: 'urjaonly@gmail.com',
  isVerified: true,
  phone: '+917309022755',
  uid: '6gktdvJsapcUKvJVVCT5j1sN3Ct2',
};

let db = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

function isServiceAccount(obj) {
  return obj && obj.type === 'service_account' && typeof obj.private_key === 'string';
}

export function initFirestore(credential) {
  if (db) return db;

  const cred = typeof credential === 'string' ? JSON.parse(credential) : credential;

  if (!getApps().length) {
    if (isServiceAccount(cred)) {
      initializeApp({ credential: cert(cred) });
      log.info('[FIRESTORE] Initialized with Service Account (admin access).');
    } else if (cred && cred.apiKey && cred.projectId) {
      initializeApp({ projectId: cred.projectId || PROJECT_ID });
      log.info(`[FIRESTORE] Initialized with web config (projectId: ${cred.projectId}).`);
      log.warning(
        '[FIRESTORE] Web config mode: ensure GOOGLE_APPLICATION_CREDENTIALS is set, ' +
        'OR get a Service Account key from Firebase Console → Project Settings → Service Accounts.'
      );
    } else {
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

// ─── Small helpers ────────────────────────────────────────────────────────────

function n(v) {
  if (v === undefined || v === null || v === 'not_found') return null;
  return v;
}

function slugify(str) {
  if (!str) return '';
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseBathsNum(str) {
  if (str == null) return null;
  const m = String(str).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function parseBedsNum(str) {
  if (str == null) return null;
  if (/studio/i.test(String(str))) return 0;
  const m = String(str).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** "$850 /Month" | "₹15,000/month" → { amount, currency, mode } */
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

function parseAreaNum(str) {
  if (str == null) return null;
  const m = String(str).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

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

function parsePostedOnTimestamp(str) {
  if (!str || typeof str !== 'string') return null;
  const d = new Date(str.trim());
  if (isNaN(d.getTime())) return null;
  return Timestamp.fromDate(d);
}

function addOneYear(ts) {
  if (!ts) return null;
  const d = ts.toDate();
  d.setFullYear(d.getFullYear() + 1);
  return Timestamp.fromDate(d);
}

function toDateStr(ts) {
  if (!ts) return null;
  const d = ts.toDate();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function extractRentFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const expM = text.match(/expected\s+rent[:\s]*\r?\n\s*(\$[\d,]+(?:\.\d+)?(?:\s*\/\s*\w+)?)/i);
  if (expM) return expM[1];
  const rentLabelM = text.match(/\brent[:\s]+\*?\s*(\$[\d,]+(?:\.\d+)?(?:\s*\/?\s*(?:month|mo\.?|week|day|year|yr))?)/i);
  if (rentLabelM) return rentLabelM[1];
  const perMonthM = text.match(/(\$[\d,]+(?:\.\d+)?)(?:\s*(?:per|\/)\s*month|\s*\/\s*mo\.?)/i);
  if (perMonthM) return `${perMonthM[1]} /Month`;
  return null;
}

// ── Language matching ─────────────────────────────────────────────────────────

const LANGUAGE_OPTIONS = ["English","Hindi","Tamil","Telugu","Malayalam","Gujarati","Bengali","Kannada","Urdu","Manipuri","Marathi","Nepali","Oriya","Punjabi","Sanskrit","Sindhi","Santhali","Maithili","Dogri","Assamese","Konkani","Kashmiri","Other"];
const GENDER_OPTIONS = ["Male", "Female", "Any"];

function matchOption(raw, options) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  const exact = options.find(o => o.toLowerCase() === s);
  if (exact) return exact;
  const sub = options.find(o => s.includes(o.toLowerCase()) || o.toLowerCase().includes(s));
  return sub || null;
}

function normalizeLanguages(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(r => matchOption(r, LANGUAGE_OPTIONS)).filter(Boolean);
  if (typeof raw === 'object') {
    return Object.keys(raw).filter(k => raw[k]).map(k => matchOption(k, LANGUAGE_OPTIONS)).filter(Boolean);
  }
  if (typeof raw === 'string') {
    const m = matchOption(raw, LANGUAGE_OPTIONS);
    return m ? [m] : [];
  }
  return [];
}

function normalizeAlcohol(raw) {
  if (raw == null) return null;
  const s = String(raw).toLowerCase();
  if (/not?\s+allow|no\s+alc|prohibit|not\s+ok/i.test(s)) return false;
  if (/allow|is\s+ok|\bok\b|yes|permit/i.test(s)) return true;
  return null;
}

// ── ad_type → intent mapping ──────────────────────────────────────────────────
// SCRAPPED_AD_DETAILS.adType holds the site's "Ad Type" field value:
//   "Property Offered" → intent "list"   (owner listing a place)
//   "Property Wanted"  → intent "find"   (seeker looking for a place)
function deriveIntent(scr) {
  const adType = scr?.adType;
  if (adType && /wanted/i.test(adType)) return 'find';
  if (adType && /offered/i.test(adType)) return 'list';
  return 'list';
}

// ── Closed-vocabulary preference/enum normalizers ─────────────────────────────

function normalizeStatus(raw) {
  if (raw == null) return 'enable';
  const s = String(raw).toLowerCase();
  return /disable|inactive|false|expired|closed/.test(s) ? 'disable' : 'enable';
}

function normalizeExpiryStatus(raw) {
  if (raw == null) return 'active';
  const s = String(raw).toLowerCase();
  return /expire|true/.test(s) ? 'expiry' : 'active';
}

function normalizeFurnishing(raw) {
  if (!raw) return 'unfurnished';
  const s = String(raw).toLowerCase();
  if (/semi/.test(s)) return 'semi_furnished';
  if (/bed/.test(s) && /furnish/.test(s)) return 'furnished_with_bed';
  if (/furnish/.test(s)) return 'fully_furnished';
  return 'unfurnished';
}

function matchSlugOrAny(raw, table) {
  if (!raw) return 'Any';
  const s = String(raw).trim().toLowerCase();
  for (const [slug, patterns] of Object.entries(table)) {
    if (patterns.some((p) => p.test(s))) return slug;
  }
  return 'Any';
}

const OCCUPATION_SLUGS = {
  students_only:     [/student/],
  professionals_only:[/professional/],
  no_preference:     [/don'?t mind|no preference/],
  others:            [/other/],
};
const SMOKING_SLUGS = {
  no_smoking:         [/no smoking/],
  smoke_outside_only: [/outside/],
  smoking_ok:         [/smoking is ok|smok.*ok/],
};
const PETS_SLUGS = {
  no_pets:    [/no pets/],
  only_dogs:  [/only dogs/],
  only_cats:  [/only cats/],
  any_pet_ok: [/any pet/],
};
const VEGETARIAN_SLUGS = {
  vegetarian:     [/vegetarian mandatory|^veg$/],
  non_vegetarian: [/non-?veg/],
  both:           [/both/],
};
const AGE_RANGE_SLUGS = {
  '18_to_25': [/18\s*to\s*25/],
  '18_to_50': [/18\s*to\s*50/],
  '25_to_45': [/25\s*to\s*45/],
  '40_to_55': [/40\s*to\s*55/],
  '55_to_70': [/55\s*to\s*70/],
  '70_plus':  [/70\s*plus/],
  '18_to_99': [/18\s*to\s*99/],
};

function toYesNo(val, fallback = 'Yes') {
  if (val === true) return 'Yes';
  if (val === false) return 'No';
  if (typeof val === 'string') {
    if (/^yes/i.test(val)) return 'Yes';
    if (/^no/i.test(val)) return 'No';
  }
  return fallback;
}

function toGenderSlug(raw) {
  const s = String(raw || '').toLowerCase();
  if (/female/.test(s)) return 'female_only';
  if (/male/.test(s)) return 'male_only';
  return 'any';
}

function toSeekerGender(raw) {
  const s = String(raw || '').toLowerCase();
  if (/female/.test(s)) return 'female';
  if (/male/.test(s)) return 'male';
  return 'other';
}

function toSeekerOccupation(raw) {
  const s = String(raw || '').toLowerCase();
  if (/student/.test(s)) return 'student';
  if (/professional/.test(s)) return 'professional';
  return 'other';
}

function deriveStayType(avail, scr) {
  const raw = `${avail?.stayType || ''} ${scr?.stayType || ''}`.toLowerCase();
  const short = /short/.test(raw);
  const long = /long/.test(raw) || !short;
  return { short, long };
}

// ── Amenity / utility closed-vocabulary mapping ───────────────────────────────

const AMENITY_SYNONYMS = {
  gym_fitness_center: /gym|fitness/i,
  swimming_pool:      /pool/i,
  car_park:           /\bcar\s?park|^parking$/i,
  visitors_parking:   /visitor.*parking/i,
  power_backup:       /power backup|generator/i,
  garbage_disposal:   /garbage disposal|trash chute/i,
  private_lawn:       /lawn|yard|garden/i,
  water_heater_plant: /water heater/i,
  security_system:    /security/i,
  laundry_service:    /laundry/i,
  elevator:           /elevator|lift/i,
  club_house:         /club\s?house/i,
};

const UTILITY_SYNONYMS = {
  gas:                     /\bgas\b/i,
  internet_wifi:           /wifi|internet/i,
  cable_tv:                /cable|\btv\b/i,
  trash_pickup:            /trash pickup|garbage pickup/i,
  sewer:                   /sewer/i,
  ceiling_fan:             /ceiling fan/i,
  water:                   /\bwater\b/i,
  electricity:             /electric/i,
  room_heater:             /room heater|\bheater\b/i,
  air_conditioner:         /\bac\b|air condition/i,
  refrigerator:            /refrigerator|fridge/i,
  dishwasher:              /dishwasher/i,
  kitchen:                 /kitchen/i,
  microwave:               /microwave/i,
  washer:                  /\bwasher\b/i,
  dryer:                   /\bdryer\b/i,
  ice_maker:               /ice maker/i,
  freezer:                 /freezer/i,
  covered_parking:         /covered parking/i,
  garage:                  /garage/i,
  ev_charging:             /ev charg|electric vehicle/i,
  wheelchair_access:       /wheelchair/i,
  doorman_concierge:       /doorman|concierge/i,
  package_lockers:         /package locker/i,
  bbq_grill_area:          /bbq|grill/i,
  playground:              /playground/i,
  pet_area_dog_park:       /dog park|pet area/i,
  balcony_patio:           /balcony|patio/i,
  smoke_detector:          /smoke detector/i,
  carbon_monoxide_detector:/carbon monoxide/i,
  fire_extinguisher:       /fire extinguisher/i,
  intercom:                /intercom/i,
  smart_thermostat:        /thermostat/i,
  cctv:                    /cctv|camera/i,
  window_coverings_blinds: /blinds|curtain/i,
};

function mapToSlugList(rawList, synonymTable) {
  if (!Array.isArray(rawList)) return [];
  const out = new Set();
  for (const raw of rawList) {
    if (!raw) continue;
    const s = String(raw);
    for (const [slug, re] of Object.entries(synonymTable)) {
      if (re.test(s)) { out.add(slug); break; }
    }
  }
  return [...out];
}

// ─── US Metro Area via TIGERweb ──────────────────────────────────────────────

async function fetchUsMetroAreaByLatLng(lat, lng) {
  if (lat == null || lng == null) return null;

  const geomJson = JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } });
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

  try {
    const delta = 0.3;
    const url = new URL('https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Current/MapServer/identify');
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

// ─── Document builder (schema/ad-output-schema.json) ─────────────────────────

async function buildFirestoreDoc(adData) {
  const prop  = adData.property     || {};
  const loc   = adData.location     || {};
  const meta  = adData.metadata     || {};
  const priv  = adData.privacy      || {};
  const prefs = adData.preferences  || {};
  const avail = adData.availability || {};
  const scr   = adData.SCRAPPED_AD_DETAILS || {};

  const scrTenantPrefs = scr.tenantPreferences || {};
  const scrAddInfo     = scr.additionalInfo    || {};

  // ── intent / category / role ──────────────────────────────────────────────
  const intent   = deriveIntent(scr);
  const category = intent === 'find' ? 'room' : 'property';
  const role     = intent === 'find' ? 'I am an individual' : 'I am the property owner';

  // ── numeric / rent parsing ─────────────────────────────────────────────────
  const scrRent  = parseRentStr(scr.rent);
  const scrBaths = parseBathsNum(scr.bathrooms);
  const scrBeds  = parseBedsNum(scr.bedrooms);
  const scrArea  = parseAreaNum(scr.areaSqft);

  const propRentRaw    = n(prop.rentAmount);
  const propRentParsed = typeof propRentRaw === 'string' ? parseRentStr(propRentRaw) : null;
  const propRentAmount = typeof propRentRaw === 'number' ? propRentRaw : (propRentParsed?.amount ?? null);

  const descText  = n(adData.description?.fullDescription) || n(scr.description) || null;
  const titleText = n(prop.title) || '';
  const rentFromText = parseRentStr(extractRentFromText(descText) || extractRentFromText(titleText));

  const effectiveBaths    = n(prop.baths) ?? scrBaths ?? null;
  const effectiveBeds     = n(prop.beds)  ?? scrBeds  ?? null;
  const effectiveRent     = propRentAmount ?? scrRent?.amount ?? rentFromText?.amount ?? null;
  const effectiveCurrency = propRentParsed?.currency || n(prop.rentCurrency) || scrRent?.currency || rentFromText?.currency || 'USD';
  const effectiveMode     = propRentParsed?.mode || n(prop.rentFrequency) || scrRent?.mode || rentFromText?.mode || 'per_month';
  const effectiveSqFt     = scrArea ?? n(prop.squareFeet) ?? null;
  const effectivePropertyType = normalizePropertyType(scr.propertyCategory) || normalizePropertyType(n(prop.propertyType)) || null;
  const effectiveAvailFrom = n(avail.availableFrom) || n(scr.availableFrom) || null;

  // ── dates ──────────────────────────────────────────────────────────────────
  const activeTimestamp = parsePostedOnTimestamp(scr.postedOn);
  const expiryTimestamp = addOneYear(activeTimestamp);
  const activeDateStr   = toDateStr(activeTimestamp) || n(meta.adActiveDate);
  const expiryDateStr   = toDateStr(expiryTimestamp) || n(meta.adExpiryDate);

  // ── metro area: TIGERweb for US, scraped value otherwise ─────────────────
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

  const adId = adData._adId || n(prop.adId) || n(scr.adIdOnSite) || n(scr.adId) || null;

  const photos = (() => {
    const main = (adData.photos?.items || []).map(p => n(p.url)).filter(Boolean);
    if (main.length) return main;
    return (Array.isArray(scr.photos) ? scr.photos : []).filter(Boolean);
  })();

  const description = descText;
  const title = n(prop.title) || n(scr.title) || null;

  const neighborhoods = (() => {
    const toArr = (v) => {
      if (Array.isArray(v)) return v.filter(x => x && x !== 'not_found');
      if (v && typeof v === 'string' && v !== 'not_found') return [v];
      return [];
    };
    const seen = new Set();
    const arr = [];
    for (const item of [
      ...toArr(loc.nearbyNeighborhoods),
      ...toArr(scr.nearbyNeighborhoods),
      ...toArr(scr.address?.nearbyNeighborhoods),
    ]) {
      if (!seen.has(item)) { seen.add(item); arr.push(item); }
    }
    return { primary: arr[0] || null, secondary: arr.slice(1) };
  })();

  const doc = {
    adId,

    metadata: {
      status:         normalizeStatus(meta.status),
      adexpirystatus: normalizeExpiryStatus(meta.adExpiryStatus),
      adtimezone:     n(meta.timezone) || 'America/New_York',
      admetroarea:    slugify(effectiveMetroArea) || null,
      adactivedate:   activeDateStr,
      adexpirydate:   expiryDateStr,
      intent,
      category,
      role,
    },

    user: {
      uid:         FIXED_USER.uid,
      displayName: scr.postedBy || FIXED_USER.displayName,
      email:       FIXED_USER.email,
      phone:       FIXED_USER.phone,
      isVerified:  FIXED_USER.isVerified,
      role,
      business:    FIXED_USER.business,
    },

    location: {
      display:          n(loc.displayAddress) || n(loc.subLocality) || n(loc.city) || null,
      formattedAddress: n(loc.formattedAddress),
      street:           null,
      city:             n(loc.city),
      locality:         n(loc.locality),
      subLocality:      n(loc.subLocality),
      district:         n(loc.district),
      state:            n(loc.state),
      stateCode:        n(loc.stateCode),
      country:          n(loc.country),
      countryCode:      n(loc.countryCode),
      metroArea:        effectiveMetroArea || null,
      zipcode:          n(loc.zipCode),
      lat:              n(loc.latitude),
      lng:              n(loc.longitude),
      neighborhoods,
      showOnMap:        priv.mapVisibility !== false && priv.hideAddress !== true,
    },

    details: {
      title,
      description,
      rent: {
        amount:            effectiveRent ?? 0,
        currency:          effectiveCurrency,
        mode:              effectiveMode,
        isNegotiable:      prop.negotiable === true,
        isHidden:          false,
        utilitiesIncluded: prop.utilitiesIncluded === true,
        deposit:           n(prop.deposit) ?? 0,
      },
      availability: {
        from:          effectiveAvailFrom,
        to:            '2100-12-31',
        stayType:      deriveStayType(avail, scr),
        daysAvailable: n(avail.daysAvailable) || '7 days a week',
      },
      amenities: mapToSlugList(Array.isArray(scr.amenities) ? scr.amenities : [], AMENITY_SYNONYMS),
      utilities: mapToSlugList(Array.isArray(scr.utilities) ? scr.utilities : [], UTILITY_SYNONYMS),
      furnishing: normalizeFurnishing(scrAddInfo.furnishing),
      openHouse: { date: '', startTime: '', endTime: '' },
    },

    privacy: {
      showAddressOnMap: priv.mapVisibility   !== false,
      hideAddressOnAd:  priv.hideAddress     === true,
      hidePhoneOnAd:    priv.hidePhone       === true,
      hideEmailOnAd:    priv.hideEmail       === true,
      onWhatsApp:       priv.whatsappEnabled === true,
      sharePhone:       priv.hidePhone       !== true,
    },

    photos,

    _search: {
      adId,
      userid:          FIXED_USER.uid,
      status:          normalizeStatus(meta.status),
      adexpirystatus:  normalizeExpiryStatus(meta.adExpiryStatus),
      adactivedate:    activeDateStr,
      adexpirydate:    expiryDateStr,
      title_lowercase: (title || '').toLowerCase(),
      city:            (n(loc.city)        || '').toLowerCase(),
      locality:        (n(loc.locality)    || '').toLowerCase(),
      subLocality:     (n(loc.subLocality) || '').toLowerCase(),
      district:        (n(loc.district)   || '').toLowerCase(),
      state:           (n(loc.state)      || '').toLowerCase(),
      stateCode:       n(loc.stateCode),
      country:         (n(loc.country)    || '').toLowerCase(),
      countryCode:     n(loc.countryCode),
      metroArea:       (effectiveMetroArea || '').toLowerCase(),
      zipcode:         n(loc.zipCode),
      rent:            effectiveRent ?? 0,
      currency:        effectiveCurrency,
      beds:            effectiveBeds ?? 0,
      baths:           effectiveBaths ?? 0,
      propertyType:    effectivePropertyType || (intent === 'find' ? 'shared_room' : null),
      category,
      intent,
    },
  };

  if (intent === 'list') {
    doc.propertyDetails = {
      propertyType:       effectivePropertyType,
      accommodationType:  n(prop.accommodationType) || '',
      squareFeet:         effectiveSqFt,
      beds:               effectiveBeds,
      baths:              effectiveBaths,
      buildingName:       n(prop.buildingName),
      isShared:           false,
    };
    doc.preferences = {
      occupation:      matchSlugOrAny(scrTenantPrefs.occupation || n(prefs.occupation), OCCUPATION_SLUGS),
      smoking:         matchSlugOrAny(scrAddInfo.smoking || n(prefs.smoking), SMOKING_SLUGS),
      pets:            matchSlugOrAny(scrAddInfo.pets || n(prefs.pets), PETS_SLUGS),
      vegetarian:      matchSlugOrAny(scrAddInfo.vegNonVeg || n(prefs.vegetarian), VEGETARIAN_SLUGS),
      ageRange:        matchSlugOrAny(scrTenantPrefs.ageRange || n(prefs.ageRange), AGE_RANGE_SLUGS),
      preferredGender: matchOption(scrTenantPrefs.genderPreference, GENDER_OPTIONS) || matchOption(n(prefs.preferredGender), GENDER_OPTIONS) || 'Any',
      couplesWelcome:  toYesNo(/^yes$/i.test(String(scr.couplesAllowed || '')) ? true : n(prefs.couplesWelcome)),
      alcoholAllowed:  toYesNo(normalizeAlcohol(scrTenantPrefs.alcohol) ?? (n(prefs.alcoholAllowed) != null ? Boolean(n(prefs.alcoholAllowed)) : null)),
      languages:       normalizeLanguages(n(prefs.languages)),
    };
  } else {
    doc.roomDetails = {
      bathType:          '',
      bathPreference:    '',
      genderPreference:  toGenderSlug(scrTenantPrefs.genderPreference || n(prefs.preferredGender)),
      accommodates:      n(scr.accommodates) || '',
      accommodationType: n(prop.accommodationType) || n(scr.accommodationType) || '',
    };
    doc.seeker = {
      age:        null,
      gender:     toSeekerGender(scrTenantPrefs.genderPreference || n(prefs.preferredGender)),
      occupation: toSeekerOccupation(scrTenantPrefs.occupation || n(prefs.occupation)),
      languages:  normalizeLanguages(n(prefs.languages)),
    };
  }

  return doc;
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
      const existingLoc = existing.data()?.location || {};
      const missingGeo =
        existingLoc.lat      == null ||
        !existingLoc.locality  ||
        !existingLoc.metroArea;

      if (!missingGeo) {
        log.info(`[FIRESTORE] Ad ${adId} already complete (lat/locality/metroArea present) — skipping.`);
        return false;
      }

      const doc = await buildFirestoreDoc(adData);
      await docRef.update({
        'location':          doc.location,
        '_search.city':      doc._search.city,
        '_search.district':  doc._search.district,
        '_search.locality':  doc._search.locality,
        '_search.metroArea': doc._search.metroArea,
        '_search.stateCode': doc._search.stateCode,
        '_search.zipcode':   doc._search.zipcode,
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
