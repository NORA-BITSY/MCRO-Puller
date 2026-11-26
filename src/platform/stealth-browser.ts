import { setTimeout as delay } from 'timers/promises';
import { CONFIG } from '../config.js';
import { ensureTermsAccepted } from '../waf.js';
import type { ProxyEndpoint } from './proxy-manager.js';
import type { Page, BrowserContext, Browser } from 'playwright';
import { existsSync, readFileSync } from 'fs';

type ProxySettings = { server: string; username?: string; password?: string; bypass?: string };
type PlaywrightExtra = any;

export interface StealthBrowserClient {
  mode: 'stealth-standalone';
  page: Page;
  context: BrowserContext;
  browser: Browser;
  proxy: ProxyEndpoint | null;
  gotoMcro: (url?: string) => Promise<Page>;
  close: () => Promise<void>;
}

export interface StealthBrowserOptions {
  headed?: boolean | undefined;
  executablePath?: string | undefined;
  sessionPath?: string | undefined;
  proxy: ProxyEndpoint | null;
}

async function loadStealthPlaywright(): Promise<PlaywrightExtra> {
  const mod = await import('playwright-extra');
  const stealth = (await import('puppeteer-extra-plugin-stealth')).default;
  // @ts-ignore - playwright-extra type mismatch
  const pw = mod.addExtra(mod.default);
  pw.use(stealth());
  return pw as PlaywrightExtra;
}

function parseProxyForPlaywright(proxy: ProxyEndpoint): ProxySettings {
  return {
    server: `http://${proxy.host}:${proxy.port}`,
    ...(proxy.username ? { username: proxy.username } : {}),
    ...(proxy.password ? { password: proxy.password } : {}),
  };
}

export async function createStealthBrowserClient(options: StealthBrowserOptions): Promise<StealthBrowserClient> {
  const playwrightExtra = await loadStealthPlaywright();

  const headed = options.headed ?? (process.env.COURT_BROWSER_HEADED === 'true');
  const sessionPath = options.sessionPath || process.env.COURT_SESSION_FILE || CONFIG.sessionFile;
  let storageState: string | undefined = sessionPath && existsSync(sessionPath) ? sessionPath : undefined;

  if (storageState && options.proxy) {
    const state = JSON.parse(readFileSync(sessionPath, 'utf8'));
    const before = state.cookies?.length || 0;
    state.cookies = (state.cookies || []).filter((cookie: { name: string }) =>
      !/^(TS\d+[a-f0-9]*|OClmoOot|visid_incap|nlbi_|__cf_bm)$/i.test(cookie.name)
    );
    console.log(`[StealthBrowser] Proxied context: dropped ${before - state.cookies.length} IP-bound WAF cookie(s) for fresh issuance`);
    storageState = state;
  }

  const proxyOption = options.proxy ? parseProxyForPlaywright(options.proxy) : undefined;

  console.log(`[StealthBrowser] Launching stealth Chromium (headed: ${headed}, executable: ${options.executablePath || 'default'}${proxyOption ? `, proxy: ${proxyOption.server}` : ''})...`);

  const browser = await playwrightExtra.chromium.launch({
    headless: !headed,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1440,900',
    ],
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    ...(proxyOption ? { proxy: proxyOption } : {}),
  });

  const contextOptions: any = {
    serviceWorkers: 'allow',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Chicago',
    geolocation: { longitude: -93.265, latitude: 44.9778 },
    permissions: ['geolocation'],
    colorScheme: 'light',
    reducedMotion: 'reduce',
    forcedColors: 'none',
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Sec-CH-UA': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-CH-UA-Mobile': '?0',
      'Sec-CH-UA-Platform': '"Windows"',
    },
  };
  if (storageState) contextOptions.storageState = storageState;
  const context = await browser.newContext(contextOptions);

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
    // @ts-ignore
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
    // @ts-ignore
    delete (window as unknown as { __playwright_binding__?: unknown }).__playwright_binding__;
  });

  const page = await context.newPage();

  async function settleTelemetry(): Promise<void> {
    await page.waitForLoadState('networkidle', { timeout: Math.min(CONFIG.delays.pageLoadTimeoutMs, 10000) }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  async function gotoMcro(url = CONFIG.urls.caseSearch): Promise<Page> {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.delays.pageLoadTimeoutMs });
    await settleTelemetry();
    await ensureTermsAccepted(page);
    return page;
  }

  async function close(): Promise<void> {
    try {
      if (!page.isClosed()) await page.close();
      await context.close();
      await browser.close();
    } catch {
      // ignore
    }
  }

  return {
    mode: 'stealth-standalone',
    page,
    context,
    browser,
    proxy: options.proxy,
    gotoMcro,
    close,
  };
}

export async function createStealthBrowserClientWithRetry(
  options: StealthBrowserOptions,
  maxRetries = 3,
  baseDelayMs = 2000
): Promise<StealthBrowserClient> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await createStealthBrowserClient(options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`[StealthBrowser] Launch attempt ${attempt + 1}/${maxRetries} failed: ${lastError.message}`);
      if (attempt < maxRetries - 1) {
        const delayMs = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 1000);
        await delay(delayMs);
      }
    }
  }
  throw lastError ?? new Error('Failed to create stealth browser client after retries');
}