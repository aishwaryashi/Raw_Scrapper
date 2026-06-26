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
import { getFirestore } from 'firebase-admin/firestore';
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

/**
 * Transform the scraped adData object into the Firestore document structure.
 */
function buildFirestoreDoc(adData) {
  const prop  = adData.property    || {};
  const loc   = adData.location    || {};
  const meta  = adData.metadata    || {};
  const pay   = adData.payment     || {};
  const priv  = adData.privacy     || {};
  const prefs = adData.preferences || {};
  const avail = adData.availability || {};
  const adId  = adData._adId || n(prop.adId) || null;

  const photos = (adData.photos?.items || [])
    .map(p => n(p.url))
    .filter(Boolean);

  const amenities = (typeof adData.amenities === 'object' && !Array.isArray(adData.amenities))
    ? adData.amenities
    : {};

  const stayType = (typeof avail.stayType === 'object' && avail.stayType !== null && avail.stayType !== 'not_found')
    ? avail.stayType
    : {};

  const neighborhoods = (typeof loc.neighborhoods === 'object' && loc.neighborhoods !== null && loc.neighborhoods !== 'not_found')
    ? loc.neighborhoods
    : {};

  const languages = (typeof prefs.languages === 'object' && prefs.languages !== null && prefs.languages !== 'not_found')
    ? prefs.languages
    : {};

  return {
    _search: {
      adId,
      adactivedate:    n(meta.adActiveDate),
      adexpirydate:    n(meta.adExpiryDate),
      adexpirystatus:  n(meta.adExpiryStatus) || 'active',
      baths:           n(prop.baths),
      beds:            n(prop.beds),
      category:        n(meta.category) || 'property',
      city:            (n(loc.city)      || '').toLowerCase(),
      country:         (n(loc.country)   || '').toLowerCase(),
      countryCode:     n(loc.countryCode),
      currency:        n(prop.rentCurrency) || 'INR',
      district:        (n(loc.district)  || '').toLowerCase(),
      intent:          n(meta.intent)    || 'list',
      locality:        (n(loc.locality)  || '').toLowerCase(),
      metroArea:       (n(loc.metroArea) || '').toLowerCase(),
      orderId:         n(pay.orderId),
      paymentId:       n(pay.paymentId),
      propertyType:    n(prop.propertyType),
      rent:            n(prop.rentAmount),
      state:           (n(loc.state)     || '').toLowerCase(),
      stateCode:       n(loc.stateCode),
      status:          n(meta.status)    || 'enable',
      subLocality:     (n(loc.subLocality) || '').toLowerCase(),
      title_lowercase: (n(prop.title)    || '').toLowerCase(),
      userid:          FIXED_USER.uid,
      zipcode:         n(loc.zipCode),
    },

    adId,

    details: {
      amenities,
      availability: {
        daysAvailable: n(avail.daysAvailable),
        from:          n(avail.availableFrom),
        stayType,
        to:            n(avail.availableTo),
      },
      description: n(adData.description?.fullDescription),
      openHouse:   { date: null, endTime: null, startTime: null },
      rent: {
        amount:            n(prop.rentAmount),
        currency:          n(prop.rentCurrency) || 'INR',
        deposit:           n(prop.deposit)  ?? 0,
        isHidden:          false,
        isNegotiable:      prop.negotiable  === true,
        mode:              n(prop.rentFrequency) || 'per_month',
        title:             n(prop.title),
        utilitiesIncluded: prop.utilitiesIncluded === true,
      },
      location: {
        city:             n(loc.city),
        country:          n(loc.country),
        countryCode:      n(loc.countryCode),
        display:          n(loc.displayAddress) || n(loc.subLocality),
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
      adactivedate:  n(meta.adActiveDate),
      adexpirydate:  n(meta.adExpiryDate),
      adexpirystatus: n(meta.adExpiryStatus) || 'active',
      adtimezone:    n(meta.timezone)   || 'Asia/Kolkata',
      category:      n(meta.category)   || 'property',
      createdAt:     n(meta.createdAt),
      intent:        n(meta.intent)     || 'list',
      orderId:       n(pay.orderId),
      paymentId:     n(pay.paymentId),
      role:          FIXED_USER.role,
      status:        n(meta.status)     || 'enable',
      updatedAt:     n(meta.updatedAt),
    },

    payment: {
      currency:    n(pay._raw?.currency) || 'USD',
      durationDays: n(pay.durationDays),
      method:      n(pay.paymentMethod),
      orderId:     n(pay.orderId),
      paidAmount:  n(pay.paidAmount),
      paidAt:      n(pay.paidAt),
      paymentId:   n(pay.paymentId),
      planId:      n(pay.planId),
      planName:    n(pay.planName),
      promoCode:   n(pay.promoCode),
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
      hideAddressOnAd: priv.hideAddress      === true,
      hideEmailOnAd:   priv.hideEmail        === true,
      hidePhoneOnAd:   priv.hidePhone        === true,
      onWhatsApp:      priv.whatsappEnabled  === true,
      sharePhone:      priv.hidePhone        !== true,
      showAddressOnMap: priv.mapVisibility   !== false,
    },

    propertyDetails: {
      accommodationType: n(prop.accommodationType) || '',
      baths:        n(prop.baths),
      beds:         n(prop.beds),
      buildingName: n(prop.buildingName),
      isShared:     false,
      propertyType: n(prop.propertyType),
      squareFeet:   n(prop.squareFeet),
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
      log.info(`[FIRESTORE] Ad ${adId} already exists in Firestore — duplicate, skipping.`);
      return false;
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
