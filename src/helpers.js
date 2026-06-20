/**
 * helpers.js
 * Utility functions: delays, fingerprinting, headers, URL parsing,
 * deduplication, logging, retry, exponential backoff, stats tracking.
 */

import crypto from 'crypto';
import { log } from 'crawlee';

// ─── Constants ───────────────────────────────────────────────────────────────

export const BASE_DOMAIN = 'indianroommates.sulekha.com';
export const BASE_URL = `https://${BASE_DOMAIN}`;
export const RENTALS_URL = `${BASE_URL}/rentals`;

// Label identifiers used across routes
export const LABELS = {
  LISTING: 'LISTING',
  DETAIL: 'DETAIL',
  PAGINATION: 'PAGINATION',
};

// ─── Stats Tracker ───────────────────────────────────────────────────────────

export const stats = {
  pagesCrawled: 0,
  adsFound: 0,
  adsEnqueued: 0,
  adsScraped: 0,
  adsFailed: 0,
  adsSkippedDuplicates: 0,
  apiEndpointsDiscovered: new Set(),
  errors: [],

  increment(key) {
    if (typeof this[key] === 'number') this[key]++;
  },

  addApiEndpoint(url) {
    try {
      const u = new URL(url);
      this.apiEndpointsDiscovered.add(`${u.origin}${u.pathname}`);
    } catch {}
  },

  addError(url, message) {
    this.errors.push({ url, message, ts: new Date().toISOString() });
  },

  summary() {
    return {
      pagesCrawled: this.pagesCrawled,
      adsFound: this.adsFound,
      adsEnqueued: this.adsEnqueued,
      adsScraped: this.adsScraped,
      adsFailed: this.adsFailed,
      adsSkippedDuplicates: this.adsSkippedDuplicates,
      apiEndpointsDiscovered: [...this.apiEndpointsDiscovered],
      errorCount: this.errors.length,
    };
  },

  printSummary() {
    const s = this.summary();
    log.info('─── CRAWL SUMMARY ──────────────────────────────────');
    log.info(`  Pages crawled            : ${s.pagesCrawled}`);
    log.info(`  Ads found (URLs)         : ${s.adsFound}`);
    log.info(`  Ads enqueued             : ${s.adsEnqueued}`);
    log.info(`  Ads scraped (success)    : ${s.adsScraped}`);
    log.info(`  Ads failed               : ${s.adsFailed}`);
    log.info(`  Duplicates skipped       : ${s.adsSkippedDuplicates}`);
    log.info(`  API endpoints discovered : ${s.apiEndpointsDiscovered.length}`);
    if (s.apiEndpointsDiscovered.length) {
      s.apiEndpointsDiscovered.forEach((ep) => log.info(`    • ${ep}`));
    }
    log.info(`  Errors logged            : ${s.errorCount}`);
    log.info('────────────────────────────────────────────────────');
  },
};

// ─── Deduplication ───────────────────────────────────────────────────────────

const seenUrls = new Set();
const seenAdIds = new Set();

export function isDuplicate(url, adId) {
  const normUrl = normalizeUrl(url);
  if (normUrl && seenUrls.has(normUrl)) return true;
  if (adId && seenAdIds.has(String(adId))) return true;
  return false;
}

export function markSeen(url, adId) {
  if (url) seenUrls.add(normalizeUrl(url));
  if (adId) seenAdIds.add(String(adId));
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

// ─── Random Delays ───────────────────────────────────────────────────────────

/**
 * Await a random delay between minMs and maxMs.
 */
export async function randomDelay(minMs = 2000, maxMs = 7000) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

// ─── Exponential Backoff ─────────────────────────────────────────────────────

/**
 * Compute exponential backoff delay.
 * @param {number} attempt - 0-indexed attempt number
 * @param {number} baseMs - base milliseconds
 * @param {number} maxMs - cap in milliseconds
 */
export function backoffDelay(attempt, baseMs = 1000, maxMs = 30000) {
  const delay = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = Math.floor(Math.random() * 1000);
  return delay + jitter;
}

/**
 * Retry an async function with exponential backoff.
 */
export async function retryWithBackoff(fn, retries = 3, baseMs = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const delay = backoffDelay(attempt, baseMs);
        log.warning(`Retry attempt ${attempt + 1}/${retries} after ${delay}ms – ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ─── User Agents ─────────────────────────────────────────────────────────────

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];

export function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── Viewports ───────────────────────────────────────────────────────────────

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 800 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 2560, height: 1440 },
];

export function randomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

// ─── Custom Headers ───────────────────────────────────────────────────────────

export function buildHeaders(userAgent) {
  const ua = userAgent || randomUserAgent();
  return {
    'User-Agent': ua,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    Referer: BASE_URL,
  };
}

// ─── URL Helpers ──────────────────────────────────────────────────────────────

/**
 * Check if a URL is a rental detail page.
 * Pattern: /<slug>_rentals_<city-state>_<id>
 */
export function isDetailUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return /^\/[^/]+_rentals_[^/]+_\d+\/?$/.test(pathname);
  } catch {
    return false;
  }
}

/**
 * Check if a URL is a listing/category page on the same domain.
 */
export function isListingUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.includes(BASE_DOMAIN)) return false;
    return (
      u.pathname === '/rentals' ||
      u.pathname.startsWith('/rentals/') ||
      u.pathname.endsWith('/rentals') ||
      /\/rentals\?/.test(u.href) ||
      /page=\d+/.test(u.search)
    );
  } catch {
    return false;
  }
}

/**
 * Check if the URL belongs to the target domain.
 */
export function isSameDomain(url) {
  try {
    return new URL(url).hostname.includes(BASE_DOMAIN);
  } catch {
    return false;
  }
}

/**
 * Extract adId from a detail URL.
 * e.g. /1-bed-room-basement-apt_rentals_ashburn-va_2027510 → "2027510"
 */
export function extractAdIdFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/_(\d+)\/?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ─── Safe JSON Parse ─────────────────────────────────────────────────────────

export function safeJsonParse(str) {
  if (!str || typeof str !== 'string') return null;
  try {
    return JSON.parse(str);
  } catch {
    // Try to extract JSON from within a larger string
    const match = str.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ─── Deep Merge ───────────────────────────────────────────────────────────────

/**
 * Deep merge multiple objects. Later arguments override earlier.
 * Does not mutate originals.
 */
export function deepMerge(...objects) {
  const result = {};
  for (const obj of objects) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    for (const [key, val] of Object.entries(obj)) {
      if (
        val !== null &&
        typeof val === 'object' &&
        !Array.isArray(val) &&
        result[key] !== null &&
        typeof result[key] === 'object' &&
        !Array.isArray(result[key])
      ) {
        result[key] = deepMerge(result[key], val);
      } else {
        result[key] = val;
      }
    }
  }
  return result;
}

// ─── Normalize Missing Values ────────────────────────────────────────────────

const NOT_FOUND = 'not_found';

/**
 * Recursively walk an object and replace null / undefined with "not_found".
 * Preserves arrays, numbers, booleans, strings, dates.
 */
export function normalizeMissing(obj) {
  if (obj === null || obj === undefined) return NOT_FOUND;
  if (typeof obj === 'boolean' || typeof obj === 'number') return obj;
  if (typeof obj === 'string') return obj.trim() === '' ? NOT_FOUND : obj;
  if (obj instanceof Date) return obj;
  if (Array.isArray(obj)) return obj.map(normalizeMissing);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = normalizeMissing(v);
    }
    return out;
  }
  return obj;
}

// ─── Hash / fingerprint ──────────────────────────────────────────────────────

export function hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

// ─── URL pagination builder ──────────────────────────────────────────────────

/**
 * Build a pagination URL from a base URL and page number.
 * Handles both query-param and path-based pagination.
 */
export function buildPaginationUrl(baseUrl, page) {
  try {
    const u = new URL(baseUrl);
    if (u.searchParams.has('page')) {
      u.searchParams.set('page', page);
      return u.toString();
    }
    // Try appending ?page=N
    u.searchParams.set('page', page);
    return u.toString();
  } catch {
    return `${baseUrl}?page=${page}`;
  }
}

// ─── Truncate long strings for logs ─────────────────────────────────────────

export function truncate(str, maxLen = 120) {
  if (!str) return '';
  const s = String(str);
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

// ─── Flatten nested object keys (for logging) ────────────────────────────────

export function flattenKeys(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenKeys(v, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

// ─── Not-found placeholder check ─────────────────────────────────────────────

/**
 * Returns true if the value is the "not_found" placeholder or effectively empty.
 */
export function isNotFound(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string' && (val.trim() === '' || val === 'not_found')) return true;
  return false;
}

// ─── Image URL filter ─────────────────────────────────────────────────────────

/**
 * Patterns that identify non-property images (ads, logos, icons, etc.).
 * Returns true if the URL should be REJECTED.
 */
const REJECT_IMG_PATTERNS = /logo|icon|banner|ad[_-]?img|sponsor|avatar|profile|badge|star|rating|pixel|tracker|beacon/i;

export function isRejectedImageUrl(url, alt = '') {
  if (!url) return true;
  if (url.startsWith('data:')) return true;
  if (REJECT_IMG_PATTERNS.test(url)) return true;
  if (alt && REJECT_IMG_PATTERNS.test(alt)) return true;
  return false;
}

// ─── Daily dedup via KeyValueStore ───────────────────────────────────────────
// Loaded from KVS before the crawl starts, persisted after it ends.
// Ensures re-runs on subsequent days skip ads already saved to the dataset.

const _seenAdIdsKvs = new Set();

export function isSeenInKvs(adId) {
  return !!adId && _seenAdIdsKvs.has(String(adId));
}

export function markSeenInKvs(adId) {
  if (adId) _seenAdIdsKvs.add(String(adId));
}

export function loadSeenAdIds(ids = []) {
  for (const id of ids) if (id) _seenAdIdsKvs.add(String(id));
}

export function getSeenAdIds() {
  return [..._seenAdIdsKvs];
}
