/**
 * routes.js
 * Route handlers for PlaywrightCrawler.
 *
 * LABELS.LISTING  – Listing/category/pagination pages
 * LABELS.DETAIL   – Individual rental ad detail pages
 */

import { Dataset, log } from 'crawlee';
import {
  LABELS,
  stats,
  randomDelay,
  isDuplicate,
  markSeen,
  isDetailUrl,
  isListingUrl,
  isSameDomain,
  extractAdIdFromUrl,
  buildPaginationUrl,
  truncate,
} from './helpers.js';
import { extractListingPage, extractDetailPage } from './extract.js';

// ─── Network API capture helper ──────────────────────────────────────────────

/**
 * Attach route interception to a Playwright page to capture XHR / fetch JSON.
 * Returns a collector array that will be populated as requests complete.
 * Call detachInterception() when done.
 */
function attachApiInterception(page, inputConfig) {
  const captured = [];
  const seenUrls = new Set();

  const onResponse = async (response) => {
    try {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';

      // Only capture JSON responses from relevant endpoints
      if (!ct.includes('application/json') && !ct.includes('text/plain')) return;
      if (seenUrls.has(url)) return;
      seenUrls.add(url);

      // Skip static assets
      if (/\.(js|css|png|jpg|svg|ico|woff|woff2|ttf)/.test(url)) return;

      stats.addApiEndpoint(url);

      const text = await response.text().catch(() => null);
      if (!text || text.length < 10) return;

      captured.push({ url, data: text, status: response.status() });

      if (inputConfig.debugMode) {
        log.debug(`[API] Captured: ${truncate(url, 100)} (${text.length} bytes)`);
      }
    } catch {
      // Ignore interception errors
    }
  };

  page.on('response', onResponse);

  const detach = () => {
    try { page.off('response', onResponse); } catch {}
  };

  return { captured, detach };
}

// ─── Route: LISTING ──────────────────────────────────────────────────────────

export async function handleListing(context, inputConfig, requestQueue) {
  const { request, page, enqueueLinks, crawler } = context;
  const { url } = request;
  const { minDelayMs = 2000, maxDelayMs = 7000, maxPaginationPages = 0, debugMode = false } = inputConfig;

  stats.increment('pagesCrawled');
  log.info(`[LISTING] Crawling: ${truncate(url, 100)}`);

  // Random delay
  await randomDelay(minDelayMs, maxDelayMs);

  // Wait for page content
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  } catch {
    log.warning(`[LISTING] waitForLoadState timeout on ${url}`);
  }

  // Allow dynamic content to settle
  await page.waitForTimeout(2000);

  const html = await page.content();

  // Extract detail URLs and pagination
  const { detailUrls, nextPageUrl, totalCount } = extractListingPage(html, url);

  if (totalCount !== null) {
    log.info(`[LISTING] Total ads reported on page: ${totalCount}`);
  }

  log.info(`[LISTING] Found ${detailUrls.length} detail URLs on ${truncate(url, 80)}`);
  stats.adsFound += detailUrls.length;

  // Enqueue all detail URLs
  let enqueuedCount = 0;
  for (const detailUrl of detailUrls) {
    const adId = extractAdIdFromUrl(detailUrl);

    if (isDuplicate(detailUrl, adId)) {
      stats.increment('adsSkippedDuplicates');
      if (debugMode) log.debug(`[LISTING] Duplicate skipped: ${truncate(detailUrl, 80)}`);
      continue;
    }

    markSeen(detailUrl, adId);

    // Check maxItems limit against how many detail URLs we've actually enqueued
    if (inputConfig.maxItems > 0 && stats.adsEnqueued >= inputConfig.maxItems) {
      log.info(`[LISTING] maxItems (${inputConfig.maxItems}) detail URLs already enqueued, stopping.`);
      break;
    }

    await requestQueue.addRequest({
      url: detailUrl,
      label: LABELS.DETAIL,
      userData: { adId },
    }, { forefront: false });
    stats.increment('adsEnqueued');
    enqueuedCount++;
  }

  log.info(`[LISTING] Enqueued ${enqueuedCount}/${detailUrls.length} detail URLs (skipped ${detailUrls.length - enqueuedCount} duplicates).`);

  // ── Pagination ──────────────────────────────────────────────────────────────

  // Track current page number in userData
  const currentPage = request.userData?.page || 1;

  // Check maxPaginationPages limit
  if (maxPaginationPages > 0 && currentPage >= maxPaginationPages) {
    log.info(`[LISTING] Reached maxPaginationPages (${maxPaginationPages}), stopping pagination.`);
    return;
  }

  if (nextPageUrl && nextPageUrl !== url) {
    // Avoid infinite loops: only enqueue if URL is different
    const isAlreadyQueued = isDuplicate(nextPageUrl, null);
    if (!isAlreadyQueued) {
      markSeen(nextPageUrl, null);
      log.info(`[LISTING] Enqueueing next page: ${truncate(nextPageUrl, 100)}`);
      await requestQueue.addRequest({
        url: nextPageUrl,
        label: LABELS.LISTING,
        userData: { page: currentPage + 1 },
      });
    } else {
      log.debug(`[LISTING] Next page already seen: ${truncate(nextPageUrl, 100)}`);
    }
  } else {
    // Try to find more URLs directly from DOM using enqueueLinks
    // This handles cases where JS-rendered pagination links weren't captured
    await enqueueLinks({
      selector: 'a[href]',
      transformRequestFunction(req) {
        const href = req.url;
        if (!isSameDomain(href)) return false;
        if (!isListingUrl(href)) return false;
        if (isDuplicate(href, null)) return false;
        markSeen(href, null);
        req.label = LABELS.LISTING;
        req.userData = { page: currentPage + 1 };
        return req;
      },
    });
  }
}

// ─── Route: DETAIL ───────────────────────────────────────────────────────────

export async function handleDetail(context, inputConfig, dataset) {
  const { request, page } = context;
  const { url } = request;
  const { minDelayMs = 2000, maxDelayMs = 7000, interceptApiCalls = true, debugMode = false } = inputConfig;

  log.info(`[DETAIL] Scraping: ${truncate(url, 100)}`);
  log.info(`[DETAIL] adsScraped=${stats.adsScraped}, adsFailed=${stats.adsFailed}, adsFound=${stats.adsFound}`);

  // Attach API interception before navigating
  let apiCapture = { captured: [], detach: () => {} };
  if (interceptApiCalls) {
    apiCapture = attachApiInterception(page, inputConfig);
  }

  // Random delay
  await randomDelay(minDelayMs, maxDelayMs);

  try {
    // Wait for main content
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() =>
      page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {})
    );

    // Extra wait for JS rendering
    await page.waitForTimeout(2500);

    // Scroll to trigger lazy loading
    await autoScroll(page);

    // Wait for gallery / image section to load before extracting
    try {
      await page.waitForSelector('img', { timeout: 10000 });
    } catch {
      log.debug('[DETAIL] No img elements found within 10s, continuing.');
    }
    // Brief settle time for lazy-loaded images
    await page.waitForTimeout(1500);

    const html = await page.content();

    // Detach API interception
    apiCapture.detach();

    if (debugMode) {
      log.debug(`[DETAIL] HTML size: ${html.length} bytes, API calls captured: ${apiCapture.captured.length}`);
    }

    // Extract all data (pass page for live DOM extraction)
    const adData = await extractDetailPage({
      url,
      html,
      apiPayloads: apiCapture.captured,
      inputConfig,
      page,
    });

    // Check maxItems
    if (inputConfig.maxItems > 0 && stats.adsScraped >= inputConfig.maxItems) {
      log.info(`[DETAIL] maxItems (${inputConfig.maxItems}) reached. Skipping save.`);
      return;
    }

    log.info(`[DETAIL] Extraction complete for ${truncate(url, 80)}, pushing to dataset...`);

    if (!adData) {
      log.error(`[DETAIL] extractDetailPage returned null/undefined for ${truncate(url, 80)}`);
      stats.increment('adsFailed');
      stats.addError(url, 'extractDetailPage returned null');
      return;
    }

    // Push to dataset
    await dataset.pushData(adData);
    stats.increment('adsScraped');

    log.info(`[DETAIL] ✓ Saved ad: ${adData._adId || 'unknown'} — ${truncate(String(adData.property?.title || ''), 60)}`);

  } catch (err) {
    apiCapture.detach();
    stats.increment('adsFailed');
    stats.addError(url, err.message);
    log.error(`[DETAIL] Failed: ${truncate(url, 80)} — ${err.message}`);
    throw err; // Let Crawlee retry
  }
}

// ─── Auto Scroll ─────────────────────────────────────────────────────────────

async function autoScroll(page, maxScrolls = 5) {
  try {
    for (let i = 0; i < maxScrolls; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
      await page.waitForTimeout(400);
    }
    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch {
    // Ignore scroll errors
  }
}

// ─── Route Dispatcher ────────────────────────────────────────────────────────

/**
 * Build the router map for PlaywrightCrawler.
 */
export function buildRouter(inputConfig, requestQueue, dataset) {
  return {
    [LABELS.LISTING]: (ctx) => handleListing(ctx, inputConfig, requestQueue),
    [LABELS.DETAIL]: (ctx) => handleDetail(ctx, inputConfig, dataset),
  };
}
