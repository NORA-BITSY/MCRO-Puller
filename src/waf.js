import { CONFIG } from './config.js';

/**
 * Sleep for a random jittered duration between min and max ms.
 * Emulates human pauses to avoid rate limiting and anomaly detection.
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
    return { blocked: false };
  }
}

/**
 * Normalize MCRO accessible case numbers (e.g., "6 7 dash C V dash 2 6 dash 3 0 0" -> "67-CV-26-300").
 */
export function normalizeCaseNumber(raw) {
  if (!raw) return '';
  const converted = raw
    .replace(/\bdash\b/gi, '-')
    .replace(/\s+/g, '')
    .toUpperCase();

  // Match Minnesota standard court case pattern (e.g., 67-CV-26-300, 27-CV-HC-26-7572, 69VI-VB-26-3230)
  const match = converted.match(/(\d{1,2}[A-Z]{0,2}-[A-Z]{2,4}(?:-[A-Z0-9]+)*-\d+)/i);
  if (match) {
    return match[1].toUpperCase();
  }
  return converted;
}
