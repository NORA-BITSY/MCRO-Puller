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
 * Detect the terms dialog and accept it on the operator's behalf, proceeding
 * past the modal so source work can continue.
 */
export async function ensureTermsAccepted(page) {
  try {
    const acceptBtn = page.locator('#tcModalAcceptBtn');
    const isVisible = await acceptBtn.isVisible({ timeout: 2500 });
    if (isVisible) {
      await acceptBtn.click();
    }
  } catch (err) {
    throw new Error(`Unable to inspect or accept MCRO terms: ${err.message}`, { cause: err });
  }
  return false;
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
