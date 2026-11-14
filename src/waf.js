import { CONFIG } from './config.js';

export function requireLiveMn() {
  if (process.env.COURT_ALLOW_LIVE_MN !== 'true') {
    throw Object.assign(new Error('Live Minnesota acquisition requires COURT_ALLOW_LIVE_MN=true'), { code: 'blocked' });
  }
}

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
    const isVisible = await acceptBtn.isVisible({ timeout: 2500 });
    if (isVisible) {
      console.log('  [WAF] Terms and Conditions modal detected; accepting...');
      await acceptBtn.click();
      await page.waitForTimeout(1000);
      return true;
    }
  } catch (err) {
    throw new Error(`Unable to inspect or accept MCRO terms: ${err.message}`, { cause: err });
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
    const content = await page.content();

    const blockIndicators = [
      'access denied',
      'attention required! | cloudflare',
      '403 forbidden',
      'security challenge',
      'request blocked',
      'volt-adc',
      'the requested url was rejected',
      'verify you are human',
      'complete the captcha',
      'too many requests',
      'unusual traffic',
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

    if (typeof page.locator === 'function') {
      const challenge = page.locator('iframe[title*="challenge" i], iframe[title*="recaptcha" i], .g-recaptcha');
      for (const item of await challenge.all()) {
        if (await item.isVisible()) return { blocked: true, reason: 'Visible CAPTCHA challenge requires operator intervention' };
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
  const normalizedLeft = normalizeCaseNumber(left);
  const normalizedRight = normalizeCaseNumber(right);
  if (!normalizedLeft || !normalizedRight) return false;
  const withoutLeadingZeros = (value) => value.replace(/^0+(?=\d)/, '');
  const leftParts = normalizedLeft.split('-');
  const rightParts = normalizedRight.split('-');
  if (leftParts.length >= 4 && rightParts.length >= 4) {
    for (const parts of [leftParts, rightParts]) {
      parts[parts.length - 1] = withoutLeadingZeros(parts.at(-1));
      parts[parts.length - 2] = withoutLeadingZeros(parts.at(-2));
    }
    return leftParts.join('-') === rightParts.join('-');
  }
  const parts = leftParts.length >= 4 ? leftParts : rightParts;
  const compact = leftParts.length >= 4 ? normalizedRight : normalizedLeft;
  if (parts.length < 4) return normalizedLeft === normalizedRight;
  // Interpret a dashless request using the observed source's county/type/year,
  // rather than guessing where an arbitrary digit string splits.
  const prefix = parts.slice(0, -2).join('') + parts.at(-2);
  if (!compact.startsWith(prefix)) return false;
  const sequence = compact.slice(prefix.length);
  return /^\d+$/.test(sequence) && withoutLeadingZeros(sequence) === withoutLeadingZeros(parts.at(-1));
}
