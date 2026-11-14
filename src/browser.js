import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CONFIG } from './config.js';
import { ensureTermsAccepted, checkWafBlock, requireLiveMn } from './waf.js';

/**
 * @typedef {Object} BrowserClient
 * @property {'extension'|'standalone'} mode
 * @property {import('playwright').Page} page
 * @property {import('playwright').BrowserContext} context
 * @property {(url?: string) => Promise<import('playwright').Page>} gotoMcro
 * @property {() => Promise<void>} close
 * @property {() => Promise<void>} [saveSession]
 * @property {import('playwright').Browser} [browser]
 */

/** @typedef {{ error: unknown, close: () => Promise<void> }} SourceRequestGate */

/**
 * Install before navigating. Interception is required, never silently bypassed.
 * @param {import('playwright').BrowserContext} browserContext Isolated, adapter-owned context.
 * @param {import('./platform/contracts.js').AcquisitionContext} context
 * @returns {Promise<SourceRequestGate>}
 */
export async function installSourceRequestGate(browserContext, context = {}) {
  if (typeof browserContext.route !== 'function' || typeof browserContext.unroute !== 'function') {
    throw Object.assign(new Error('Source request interception is unavailable; refusing unbudgeted live acquisition'), { code: 'unsupported' });
  }
  const origin = new URL(CONFIG.urls.caseSearch).origin;
  let nextRequestAt = 0;
  /** @type {unknown} */
  let failure;
  /** @param {import('playwright').Route} route */
  const handler = async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== origin || !['document', 'xhr', 'fetch'].includes(request.resourceType())) {
      await route.continue();
      return;
    }
    try {
      if (failure) throw failure;
      context.signal?.throwIfAborted();
      if (context.beforeRequest) await context.beforeRequest();
      else {
        // Legacy CLI has no shared database budget, but still serializes each
        // source data request at the configured cooperative minimum interval.
        const reservedAt = Math.max(Date.now(), nextRequestAt);
        nextRequestAt = reservedAt + CONFIG.delays.minDelayMs;
        if (reservedAt > Date.now()) await delay(reservedAt - Date.now(), undefined, { signal: context.signal });
      }
      if (failure) throw failure;
      context.signal?.throwIfAborted();
      await route.continue();
    } catch (error) {
      failure ??= error;
      await route.abort('blockedbyclient').catch(() => {});
    }
  };
  /** @param {import('playwright').Response} response */
  const onResponse = (response) => {
    if (new URL(response.url()).origin !== origin || !['document', 'xhr', 'fetch'].includes(response.request().resourceType()) || ![403, 429].includes(response.status())) return;
    const retryAfter = response.headers()['retry-after'];
    const retryAfterMs = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : undefined;
    failure = Object.assign(new Error(`Minnesota source returned HTTP ${response.status()}; acquisition stopped`), {
      code: 'blocked',
      ...(Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
    });
  };
  try { await browserContext.route('**/*', handler); }
  catch (error) { throw Object.assign(new Error('Browser cannot enforce source request budget interception', { cause: error }), { code: 'unsupported' }); }
  browserContext.on('response', onResponse);
  return {
    get error() { return failure; },
    async close() { browserContext.off('response', onResponse); await browserContext.unroute('**/*', handler); },
  };
}

/** @returns {Promise<BrowserClient>} */

export async function createBrowserClient(options = {}) {
  requireLiveMn();
  const mode = options.mode || 'extension'; // 'extension' | 'standalone'
  if (!['extension', 'standalone'].includes(mode)) throw new Error(`Unknown browser mode: ${mode}`);

  const client = mode === 'extension' ? await createExtensionClient(options) : await createStandaloneClient(options);
  try {
    await installSourceRequestGate(client.context, options.acquisitionContext || {});
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

/**
 * Attempt the documented CDP Browser.newContext API. Never reuse the operator's
 * default context when isolation is unavailable, and never retry after a block.
 * @param {import('playwright').Browser} browser
 * @returns {Promise<import('playwright').BrowserContext>}
 */
export async function createIsolatedExtensionContext(browser) {
  try { return await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true }); }
  catch (error) {
    throw Object.assign(new Error('Extension CDP bridge cannot create an isolated, budget-enforced source context; use standalone mode', { cause: error }), { code: 'unsupported' });
  }
}

async function createExtensionClient(options) {
  const { connectViaExtension } = await import('playwriter');
  const tabGroup = options.tabGroup || 'mcro';

  console.log(`[Browser] Connecting via Playwriter extension (tabGroup: ${tabGroup})...`);
  let connection;
  try {
    connection = await connectViaExtension({ tabGroup });
  } catch (err) {
    throw new Error(
      `Failed to connect to Chrome via Playwriter extension: ${err.message}.\n` +
      `Ensure Google Chrome is open with the Playwriter extension active, or use --mode standalone.`
    );
  }

  let context;
  try { context = await createIsolatedExtensionContext(connection.browser); }
  catch (error) { await connection.close(); throw error; }
  let page;
  try { page = await context.newPage(); }
  catch (error) { await context.close(); await connection.close(); throw error; }

  // Helper to safely navigate with terms check
  async function gotoMcro(url = CONFIG.urls.caseSearch) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.delays.pageLoadTimeoutMs });
    await page.waitForTimeout(1000);
    await ensureTermsAccepted(page);
    const wafCheck = await checkWafBlock(page);
    if (wafCheck.blocked) {
      throw Object.assign(new Error(wafCheck.reason), { code: 'blocked' });
    }
    return page;
  }

  async function close() {
    try { await context.close(); }
    finally { await connection.close(); }
  }

  return {
    mode: 'extension',
    page,
    context,
    gotoMcro,
    close,
  };
}

async function createStandaloneClient(options) {
  const { chromium } = await import('playwright');

  const headed = options.headed ?? false;
  const sessionPath = options.sessionPath || CONFIG.sessionFile;
  const storageState = fs.existsSync(sessionPath) ? sessionPath : undefined;

  if (options.proxy) throw new Error('MCRO adapter does not support proxy configuration or rotation');
  console.log(`[Browser] Launching standard Chromium (headed: ${headed})...`);
  const browser = await chromium.launch({ headless: !headed });

  const context = await browser.newContext({
    storageState,
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    acceptDownloads: true,
  });

  const page = await context.newPage();

  async function gotoMcro(url = CONFIG.urls.caseSearch) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.delays.pageLoadTimeoutMs });
    await page.waitForTimeout(1000);
    await ensureTermsAccepted(page);
    const wafCheck = await checkWafBlock(page);
    if (wafCheck.blocked) {
      throw Object.assign(new Error(wafCheck.reason), { code: 'blocked' });
    }
    return page;
  }

  async function saveSession() {
    const dir = path.dirname(sessionPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await context.storageState({ path: sessionPath });
    console.log(`[Browser] Session saved to ${sessionPath}`);
  }

  async function close() {
    try {
      if (!page.isClosed()) await page.close();
      await context.close();
      await browser.close();
    } catch (e) {
      // ignore
    }
  }

  return {
    mode: 'standalone',
    page,
    context,
    browser,
    gotoMcro,
    saveSession,
    close,
  };
}
