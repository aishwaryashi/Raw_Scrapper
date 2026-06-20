/**
 * main.js
 * Apify Actor entry point for the Sulekha Rentals Scraper.
 *
 * Architecture:
 *  - PlaywrightCrawler with Chromium
 *  - RequestQueue for deduplication
 *  - ProxyConfiguration (residential)
 *  - Dataset for output
 *  - Router-based route handling (LISTING / DETAIL)
 *  - Full anti-blocking: UA rotation, viewport randomization, fingerprint evasion
 *  - Exponential backoff on failures
 *  - Graceful shutdown with stats summary
 */

import { Actor, ProxyConfiguration, log } from 'apify';
import { PlaywrightCrawler, RequestQueue, Dataset, Configuration } from 'crawlee';

import {
  LABELS,
  stats,
  randomUserAgent,
  randomViewport,
  buildHeaders,
  isDetailUrl,
  isListingUrl,
  isDuplicate,
  markSeen,
  extractAdIdFromUrl,
  truncate,
} from './helpers.js';
import { buildRouter } from './routes.js';

// ─── Actor Init ───────────────────────────────────────────────────────────────

await Actor.init();

// ─── Input ────────────────────────────────────────────────────────────────────

const input = await Actor.getInput() ?? {};

const inputConfig = {
  startUrls: input.startUrls?.length
    ? input.startUrls.map((s) => (typeof s === 'string' ? { url: s } : s))
    : [{ url: 'https://indianroommates.sulekha.com/rentals' }],
  maxItems: input.maxItems ?? 0,
  maxConcurrency: input.maxConcurrency ?? 3,
  maxRequestRetries: input.maxRequestRetries ?? 5,
  requestTimeoutSecs: input.requestTimeoutSecs ?? 90,
  minDelayMs: input.minDelayMs ?? 2000,
  maxDelayMs: input.maxDelayMs ?? 7000,
  useProxy: input.useProxy !== false,
  proxyConfig: input.proxyConfig ?? { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  interceptApiCalls: input.interceptApiCalls !== false,
  extractNextData: input.extractNextData !== false,
  extractLdJson: input.extractLdJson !== false,
  maxPaginationPages: input.maxPaginationPages ?? 0,
  debugMode: input.debugMode ?? false,
};

if (inputConfig.debugMode) {
  log.setLevel(log.LEVELS.DEBUG);
} else {
  log.setLevel(log.LEVELS.INFO);
}

log.info('Sulekha Rentals Scraper starting…');
log.info(`Config: maxItems=${inputConfig.maxItems}, maxConcurrency=${inputConfig.maxConcurrency}, useProxy=${inputConfig.useProxy}`);

// ─── Proxy ────────────────────────────────────────────────────────────────────

let proxyConfiguration = null;

if (inputConfig.useProxy) {
  try {
    proxyConfiguration = await Actor.createProxyConfiguration(inputConfig.proxyConfig);
    log.info('Proxy configuration created (RESIDENTIAL).');
  } catch (err) {
    log.warning(`Proxy creation failed: ${err.message}. Continuing without proxy.`);
  }
}

// ─── Request Queue & Dataset ──────────────────────────────────────────────────

const requestQueue = await RequestQueue.open();
const dataset = await Dataset.open();

// Seed start URLs
for (const startUrl of inputConfig.startUrls) {
  const url = typeof startUrl === 'string' ? startUrl : startUrl.url;
  const label = isDetailUrl(url) ? LABELS.DETAIL : LABELS.LISTING;
  await requestQueue.addRequest({ url, label, userData: { page: 1 } });
  markSeen(url, null);
  log.info(`Seeded start URL: ${url} [${label}]`);
}

// ─── Router ───────────────────────────────────────────────────────────────────

const routerMap = buildRouter(inputConfig, requestQueue, dataset);

// ─── Browser Launch Options ───────────────────────────────────────────────────

const launchOptions = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-infobars',
    '--disable-background-timer-throttling',
    '--disable-popup-blocking',
    '--disable-translate',
    '--disable-extensions',
    '--ignore-certificate-errors',
    '--window-size=1920,1080',
  ],
};

// ─── Playwright Crawler ───────────────────────────────────────────────────────

const crawler = new PlaywrightCrawler({
  requestQueue,
  proxyConfiguration,
  maxConcurrency: inputConfig.maxConcurrency,
  maxRequestRetries: inputConfig.maxRequestRetries,
  requestHandlerTimeoutSecs: inputConfig.requestTimeoutSecs,
  navigationTimeoutSecs: 60,
  browserPoolOptions: {
    useFingerprints: true,  // Crawlee built-in fingerprint injection
    fingerprintOptions: {
      fingerprintGeneratorOptions: {
        browsers: ['chrome'],
        operatingSystems: ['windows', 'macos', 'linux'],
        devices: ['desktop'],
        locales: ['en-US', 'en-GB'],
      },
    },
  },
  launchContext: {
    launchOptions,
    useChrome: false,
  },

  // ── Pre-navigation hook: randomize context ──────────────────────────────────
  preNavigationHooks: [
    async (crawlingContext) => {
      const { page, request } = crawlingContext;
      const ua = randomUserAgent();
      const viewport = randomViewport();

      try {
        // Set viewport
        await page.setViewportSize(viewport);

        // Override user agent
        await page.setExtraHTTPHeaders(buildHeaders(ua));

        // Stealth: override navigator properties
        await page.addInitScript((userAgent) => {
          // Override webdriver flag
          Object.defineProperty(navigator, 'webdriver', { get: () => false });

          // Override languages
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

          // Override plugins length to non-zero
          Object.defineProperty(navigator, 'plugins', {
            get: () => {
              const arr = [1, 2, 3, 4, 5];
              arr.__proto__ = PluginArray.prototype;
              return arr;
            },
          });

          // Override platform
          Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });

          // Spoof permissions
          const originalQuery = window.navigator.permissions?.query;
          if (originalQuery) {
            window.navigator.permissions.query = (params) =>
              params.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery(params);
          }

          // Override chrome object
          window.chrome = {
            runtime: {},
            loadTimes: function () {},
            csi: function () {},
            app: {},
          };
        }, ua);

      } catch (err) {
        log.debug(`preNavigationHook error: ${err.message}`);
      }
    },
  ],

  // ── Request handler ─────────────────────────────────────────────────────────
  async requestHandler(ctx) {
    const { request } = ctx;
    const label = request.label || (isDetailUrl(request.url) ? LABELS.DETAIL : LABELS.LISTING);

    const handler = routerMap[label];
    if (!handler) {
      log.warning(`[MAIN] No handler for label "${label}" — URL: ${truncate(request.url, 80)}`);
      return;
    }

    await handler(ctx);
  },

  // ── Failure handler ─────────────────────────────────────────────────────────
  async failedRequestHandler(ctx) {
    const { request } = ctx;
    stats.increment('adsFailed');
    stats.addError(request.url, `Max retries exhausted after ${inputConfig.maxRequestRetries} attempts`);
    log.error(`[MAIN] Permanently failed: ${truncate(request.url, 100)}`);
  },

  // ── Error handler ────────────────────────────────────────────────────────────
  async errorHandler(ctx, error) {
    const { request } = ctx;
    const retryCount = request.retryCount ?? 0;
    log.warning(`[MAIN] Error on attempt ${retryCount + 1}: ${truncate(request.url, 80)} — ${error.message}`);

    // Exponential backoff: add delay before retry via userData signal
    // (Crawlee handles retries automatically; we just log here)
    stats.addError(request.url, `Attempt ${retryCount + 1}: ${error.message}`);
  },
});

// ─── Run ─────────────────────────────────────────────────────────────────────

log.info('Starting crawler…');

try {
  await crawler.run();
} catch (err) {
  log.error(`Crawler run error: ${err.message}`);
} finally {
  stats.printSummary();

  // Save stats to key-value store
  await Actor.setValue('STATS', stats.summary());

  const datasetInfo = await dataset.getInfo();
  log.info(`Dataset contains ${datasetInfo?.itemCount ?? stats.adsScraped} items.`);

  await Actor.exit();
}
