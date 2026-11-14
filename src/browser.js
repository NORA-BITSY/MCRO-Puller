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

export function findSystemChrome() {
  const candidates = [
    process.env.COURT_CHROME_BIN,
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** @returns {Promise<BrowserClient>} */

export async function createBrowserClient(options = {}) {
  requireLiveMn();
  const mode = options.mode || (process.env.COURT_BROWSER_MODE === 'extension' ? 'extension' : 'standalone');
  if (!['extension', 'standalone'].includes(mode)) throw new Error(`Unknown browser mode: ${mode}`);

  const client = mode === 'extension' ? await createExtensionClient(options) : await createStandaloneClient(options);
  try {
    const gate = await installSourceRequestGate(client.context, options.acquisitionContext || {});
    client.gate = gate;
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

async function createStandaloneClient(options = {}) {
  const { chromium } = await import('playwright');

  const headed = options.headed ?? (process.env.COURT_BROWSER_HEADED === 'true');
  const sessionPath = options.sessionPath || process.env.COURT_SESSION_FILE || CONFIG.sessionFile;
  const storageState = fs.existsSync(sessionPath) ? sessionPath : undefined;
  const executablePath = options.executablePath || findSystemChrome();

  // Operator-approved proxy routing: each concurrent worker may pin its own
  // proxy (sticky by worker index) so no single exit IP carries the full load.
  const proxy = options.proxy || undefined;
  const proxyOption = typeof proxy === 'string' ? { server: proxy } : proxy;
  console.log(`[Browser] Launching standard Chromium (headed: ${headed}, executable: ${executablePath || 'default'}${proxyOption ? `, proxy: ${proxyOption.server}` : ''})...`);
  const browser = await chromium.launch({
    headless: !headed,
    // F5 BIG-IP ASM client telemetry fingerprints automation-controlled browsers;
    // suppress Playwright's automation tells so the automated browser matches the
    // operator's real Chrome (parity, not captcha bypass).
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
    ...(executablePath ? { executablePath } : {}),
    ...(proxyOption ? { proxy: proxyOption } : {}),
  });

  const context = await browser.newContext({
    storageState,
    // Allow F5 client-telemetry service workers instead of blocking them.
    serviceWorkers: 'allow',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    acceptDownloads: true,
  });
  // Mask the remaining CDP tell that survives --disable-blink-features.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  /**
   * Let F5 client-telemetry beacons finish before the page is acted on.
   * Best-effort: networkidle is capped and never fails navigation itself.
   */
  async function settleTelemetry() {
    await page.waitForLoadState('networkidle', { timeout: Math.min(CONFIG.delays.pageLoadTimeoutMs, 10000) }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  async function gotoMcro(url = CONFIG.urls.caseSearch) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.delays.pageLoadTimeoutMs });
    await settleTelemetry();
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

  /** @type {BrowserClient} */
  let client;
  async function close() {
    try {
      if (client?.gate) await client.gate.close().catch(() => {});
      if (!page.isClosed()) await page.close();
      await context.close();
      await browser.close();
    } catch (e) {
      // ignore
    }
  }

  client = {
    mode: 'standalone',
    page,
    context,
    browser,
    gotoMcro,
    saveSession,
    close,
  };
  return client;
}
