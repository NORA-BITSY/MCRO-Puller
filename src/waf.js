import { CONFIG } from './config.js';

/**
 * Sleep for a random duration between requests. This is cooperative rate
 * limiting, not a guarantee that a request is permitted or will avoid blocks.
 */
export async function sleepJitter(minMs = CONFIG.delays.minDelayMs, maxMs = CONFIG.delays.maxDelayMs) {
  const actualMin = Math.min(minMs, maxMs);
  const actualMax = Math.max(minMs, maxMs);
  const delay = Math.floor(actualMin + Math.random() * (actualMax - actualMin));
  await new Promise((resolve) => setTimeout(resolve, delay));
  return delay;
}

/**
 * Check if Terms and Conditions dialog is visible, and accept it.
 */
export async function ensureTermsAccepted(page) {
  try {
    const acceptBtn = page.locator('#tcModalAcceptBtn');
    const isVisible = await acceptBtn.isVisible({ timeout: 2500 }).catch(() => false);
    if (isVisible) {
      console.log('  [WAF] Terms and Conditions modal detected; accepting...');
      await acceptBtn.click();
      await page.waitForTimeout(1000);
      return true;
    }
  } catch (err) {
    // modal not present
  }
  return false;
}

/**
 * Check if the page has hit a WAF, Cloudflare, or Volterra rate limit or block.
 */
export async function checkWafBlock(page) {
  try {
    const title = (await page.title()).toLowerCase();
    const url = page.url();
    const content = await page.content().catch(() => '');

    const blockIndicators = [
      'access denied',
      'attention required! | cloudflare',
      '403 forbidden',
      'security challenge',
      'request blocked',
      'volt-adc',
      'the requested url was rejected',
    ];

    for (const indicator of blockIndicators) {
      if (title.includes(indicator) || content.toLowerCase().includes(indicator)) {
        return {
          blocked: true,
          reason: `WAF block indicator found: "${indicator}" at ${url}`,
          url,
          title,
        };
      }
    }

    return { blocked: false };
  } catch (err) {
    return {
      blocked: true,
      reason: `Unable to inspect page health: ${err.message}`,
    };
  }
}

/**
 * Normalize a Minnesota case number and take only the first complete case
 * number when rendered headings repeat accessible text.
 */
export function normalizeCaseNumber(raw) {
  if (!raw) return '';
  let converted = raw
    .replace(/\bdash\b/gi, '-')
    .replace(/\s+/g, '')
    .toUpperCase();

  if (converted.length % 2 === 0) {
    const midpoint = converted.length / 2;
    if (converted.slice(0, midpoint) === converted.slice(midpoint)) {
      converted = converted.slice(0, midpoint);
    }
  }

  const match = converted.match(/\d{1,2}[A-Z]{0,2}-[A-Z]{2,4}(?:-[A-Z]{2,4})?-\d{2,4}-\d+/);
  return match ? match[0] : converted;
}

export function caseNumbersEqual(left, right) {
  const canonicalize = (value) => {
    const parts = normalizeCaseNumber(value).split('-');
    if (parts.length < 4) return normalizeCaseNumber(value);
    parts[parts.length - 1] = String(Number.parseInt(parts.at(-1), 10));
    parts[parts.length - 2] = String(Number.parseInt(parts.at(-2), 10));
    return parts.join('-');
  };
  return canonicalize(left) === canonicalize(right);
}
