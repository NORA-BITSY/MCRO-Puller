import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.js';
import { ensureTermsAccepted, checkWafBlock } from './waf.js';

export async function createBrowserClient(options = {}) {
  const mode = options.mode || 'extension'; // 'extension' | 'standalone'
  const headed = options.headed ?? false;

  if (mode === 'extension') {
    return await createExtensionClient(options);
  } else {
    return await createStandaloneClient(options);
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

  const context = connection.browser.contexts()[0];
  if (!context) {
    await connection.close().catch(() => {});
    throw new Error('Playwriter connected, but no Chrome browser context is available');
  }
  const page = await context.newPage();

  // Helper to safely navigate with terms check
  async function gotoMcro(url = CONFIG.urls.caseSearch) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.delays.pageLoadTimeoutMs });
    await page.waitForTimeout(1000);
    await ensureTermsAccepted(page);
    const wafCheck = await checkWafBlock(page);
    if (wafCheck.blocked) {
      throw new Error(`[WAF BLOCKED] ${wafCheck.reason}`);
    }
    return page;
  }

  async function close() {
    try {
      if (!page.isClosed()) {
        await page.close();
      }
      await connection.close();
    } catch (e) {
      // ignore close errors
    }
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
  const { chromium } = await import('playwright-extra');
  const stealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
  chromium.use(stealthPlugin());

  const headed = options.headed ?? false;
  const sessionPath = options.sessionPath || CONFIG.sessionFile;
  const storageState = fs.existsSync(sessionPath) ? sessionPath : undefined;

  const proxy = options.proxy ? options.proxy : undefined;
  console.log(
    `[Browser] Launching standalone Chromium (headed: ${headed}, session: ${storageState ? 'loaded' : 'none'}, proxy: ${proxy ? proxy.server : 'none'})...`
  );

  const browser = await chromium.launch({
    headless: !headed,
    proxy,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--window-position=0,0',
    ],
  });

  const context = await browser.newContext({
    storageState,
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
      throw new Error(`[WAF BLOCKED] ${wafCheck.reason}`);
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
