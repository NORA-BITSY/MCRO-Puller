import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { findSystemChrome } from '../dist/src/browser.js';
import { CONFIG } from '../dist/src/config.js';
import { persistVerifiedSession, validateSessionPage } from '../src/platform/live-acceptance.js';

const sessionPath = process.env.COURT_SESSION_FILE || CONFIG.sessionFile || path.join(os.homedir(), '.mcro-puller', 'session.json');

export function getSessionStatus(targetPath = sessionPath) {
  if (!existsSync(targetPath)) {
    return { exists: false, path: targetPath };
  }
  try {
    const stat = statSync(targetPath);
    const modeOctal = (stat.mode & 0o777).toString(8).padStart(4, '0');
    const content = JSON.parse(readFileSync(targetPath, 'utf8'));
    const cookies = Array.isArray(content.cookies) ? content.cookies : [];
    const sanitizedCookies = cookies.map((c) => ({
      name: c.name,
      domain: c.domain,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session',
    }));
    return {
      exists: true,
      path: targetPath,
      mode: modeOctal,
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
      cookieCount: cookies.length,
      cookies: sanitizedCookies,
    };
  } catch (err) {
    return { exists: true, path: targetPath, error: err.message };
  }
}

export function clearSession(targetPath = sessionPath) {
  if (!existsSync(targetPath)) {
    return { cleared: false, path: targetPath, reason: 'File does not exist' };
  }
  unlinkSync(targetPath);
  return { cleared: true, path: targetPath, message: 'Local session file removed (server-side session state not revoked)' };
}

/**
 * Converts browser-exported cookie array (e.g. from Cookie-Editor) to Playwright storageState format.
 */
export function convertCookiesToStorageState(input) {
  let cookies = [];
  if (Array.isArray(input)) {
    cookies = input;
  } else if (input && Array.isArray(input.cookies)) {
    return input; // Already Playwright storageState
  } else {
    throw new Error('Unrecognized session format; expected cookie array or Playwright storageState object');
  }

  const convertedCookies = cookies.map((c) => {
    let sameSite = 'Lax';
    if (c.sameSite) {
      const lower = c.sameSite.toLowerCase();
      if (lower === 'no_restriction' || lower === 'none') sameSite = 'None';
      else if (lower === 'strict') sameSite = 'Strict';
      else if (lower === 'lax') sameSite = 'Lax';
    }

    return {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: typeof c.expirationDate === 'number' ? c.expirationDate : (typeof c.expires === 'number' ? c.expires : -1),
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite,
    };
  });

  return {
    cookies: convertedCookies,
    origins: [
      {
        origin: 'https://publicaccess.courts.state.mn.us',
        localStorage: [],
      },
    ],
  };
}

export function importSessionFile(sourcePath, targetPath = sessionPath) {
  const raw = JSON.parse(readFileSync(sourcePath, 'utf8'));
  const storageState = convertCookiesToStorageState(raw);
  const dir = path.dirname(targetPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  writeFileSync(targetPath, JSON.stringify(storageState, null, 2), { mode: 0o600 });
  chmodSync(targetPath, 0o600);

  return getSessionStatus(targetPath);
}


export async function runInteractiveSession(options = {}) {
  const targetPath = options.sessionPath || sessionPath;
  const timeoutMs = options.timeoutMs || 300000; // 5 minute timeout

  if (process.argv.includes('--status')) {
    console.log(JSON.stringify(getSessionStatus(targetPath), null, 2));
    return;
  }

  const importIdx = process.argv.indexOf('--import');
  if (importIdx !== -1 && process.argv[importIdx + 1]) {
    const sourceFile = process.argv[importIdx + 1];
    const status = importSessionFile(sourceFile, targetPath);
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (process.argv.includes('--clear')) {
    console.log(JSON.stringify(clearSession(targetPath), null, 2));
    return;
  }

  console.log(`\n======================================================`);
  console.log(`  MCRO Human-Assisted Operator Session`);
  console.log(`======================================================`);
  console.log(`Target Session File: ${targetPath}`);

  const chromePath = options.executablePath || findSystemChrome();
  if (!chromePath) {
    throw new Error('Google Chrome or Chromium binary not found. Please set COURT_CHROME_BIN.');
  }
  console.log(`Browser Executable:  ${chromePath}`);

  console.log(`\nLaunching isolated headed browser...`);
  const browser = await chromium.launch({
    headless: false,
    executablePath: chromePath,
  });

  let context;
  try {
    const existingState = existsSync(targetPath) ? targetPath : undefined;
    context = await browser.newContext({
      storageState: existingState,
      serviceWorkers: 'block',
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    });

    const page = await context.newPage();

    console.log(`Navigating to MCRO Case Search (https://publicaccess.courts.state.mn.us/CaseSearch)...`);
    await page.goto('https://publicaccess.courts.state.mn.us/CaseSearch', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    console.log(`\n------------------------------------------------------`);
    console.log(`OPERATOR INSTRUCTIONS:`);
    console.log(`1. In the opened browser window, review the Minnesota Judicial Branch`);
    console.log(`   Terms and Conditions dialog.`);
    console.log(`2. If you choose to accept, click 'Yes, I Accept' and complete any`);
    console.log(`   interactive human validation.`);
    console.log(`3. When you have completed this in the browser, return to this terminal`);
    console.log(`   and press [ENTER] to save the session.`);
    console.log(`   (Or type 'cancel' to exit without saving).`);
    console.log(`------------------------------------------------------\n`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.log('\n[Session Timeout] No operator input received within timeout.');
        resolve('timeout');
      }, timeoutMs);

      rl.question('Press [ENTER] to save verified session (or type "cancel"): ', (ans) => {
        clearTimeout(timer);
        resolve(ans.trim().toLowerCase());
      });
    });
    rl.close();

    if (answer === 'cancel' || answer === 'timeout') {
      console.log(`Session creation cancelled. No changes were written.`);
      return;
    }

    // A saved file is not evidence of a usable browser session. Require the
    // operator's action to leave both required cookies and search controls ready.
    const validation = await validateSessionPage(page, context);
    if (!validation.usable) {
      throw new Error(`Session is not ready; no state saved (terms cookie=${validation.hasTermsCookie}, session cookie=${validation.hasSessionCookie}, search controls=${validation.hasSearchElements}, terms modal dismissed=${validation.modalDismissed})`);
    }
    console.log(`\n[Verified] Terms modal dismissed; terms/session cookies and search elements are present.`);

    const storageState = await context.storageState();
    await persistVerifiedSession(targetPath, storageState, validation);

    const status = getSessionStatus(targetPath);
    console.log(`\n======================================================`);
    console.log(`Session successfully saved!`);
    console.log(`Path:         ${status.path}`);
    console.log(`Permissions:  ${status.mode} (owner read/write only)`);
    console.log(`Cookies:      ${status.cookieCount} stored`);
    console.log(`Usable:       ${validation.usable ? 'YES' : 'PENDING_CONFIRMATION'}`);
    console.log(`======================================================\n`);
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

if (process.argv[1] && process.argv[1].endsWith('session-interactive.mjs')) {
  runInteractiveSession().catch((err) => {
    console.error('Session error:', err.message);
    process.exit(1);
  });
}
