import { CONFIG } from './config.js';
import { ensureTermsAccepted, checkWafBlock, normalizeCaseNumber, caseNumbersEqual, requireLiveMn } from './waf.js';

export async function navigateToCaseDetails(page, caseItem) {
  requireLiveMn();
  if (!caseItem.detailsHref) throw new Error('A source-provided case details URL is required; ordinal navigation is not permitted');
  const url = new URL(caseItem.detailsHref, CONFIG.urls.caseSearch);
  if (url.origin !== new URL(CONFIG.urls.caseSearch).origin) throw new Error('Case details URL is outside the Minnesota source');
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: CONFIG.delays.pageLoadTimeoutMs });
  const check = await checkWafBlock(page);
  if (check.blocked) throw Object.assign(new Error(check.reason), { code: 'blocked' });
  await ensureTermsAccepted(page);
  await page.locator('#mpa-roa-case-events-content').waitFor({ state: 'attached', timeout: CONFIG.delays.pageLoadTimeoutMs });
  const result = await parseRoa(page);
  if (!result.caseInfo.caseNumber || !caseNumbersEqual(result.caseInfo.caseNumber, caseItem.caseNumber || caseItem.caseNumberRaw)) throw Object.assign(new Error('Case details number does not match requested case'), { code: 'parse_error' });
  return result;
}

export function normalizeRoaSnapshot(snapshot) {
  const events = snapshot.events.map((event) => {
    const documents = event.documents || (event.document ? [event.document] : []);
    return { ...event, documents, hasDocument: documents.length > 0, document: documents[0] || null };
  });
  return {
    ...snapshot,
    caseInfo: { ...snapshot.caseInfo, caseNumber: normalizeCaseNumber(snapshot.caseInfo.caseNumberRaw) },
    partiesCount: snapshot.parties.length,
    totalEvents: events.length,
    documentEventsCount: events.filter((event) => event.hasDocument).length,
    totalDocuments: events.reduce((count, event) => count + event.documents.length, 0),
    events,
  };
}

export async function parseRoa(page) {
  const snapshot = await page.evaluate(() => {
    // Text only: remove active content, hidden inputs, and credential-bearing form values.
    function text(node) {
      if (!node) return '';
      const clone = node.cloneNode(true);
      clone.querySelectorAll('script, style, input, textarea, select, template, [hidden], [aria-hidden="true"]').forEach((child) => child.remove());
      // textContent remains available on detached clones; preserve source block boundaries.
      clone.querySelectorAll('br').forEach((child) => child.replaceWith('\n'));
      clone.querySelectorAll('div, p, tr, li, h1, h2, h3, h4, section, dt, dd').forEach((child) => child.append('\n'));
      return clone.textContent.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    const pageText = text(document.body);
    const extract = (label) => pageText.match(new RegExp(label + ':\\s*([^\\n]+)', 'i'))?.[1]?.trim() || '';
    const caseInfo = { caseNumberRaw: extract('Case Number'), caseTitle: extract('Case Title'), caseType: extract('Case Type'), dateFiled: extract('Date Filed'), caseLocation: extract('Case Location'), judicialOfficer: extract('Judicial Officer'), caseStatus: extract('Case Status') };
    const partiesContent = document.querySelector('#mpa-roa-case-parties-content');
    const parties = partiesContent ? [...partiesContent.querySelectorAll('.mpa-case-details-party-item')].map(text).filter(Boolean) : [];
    const eventsContent = document.querySelector('#mpa-roa-case-events-content');
    if (!eventsContent) throw new Error('Unrecognized MCRO docket: missing case event section');
    let formIndex = 0;
    const events = [...eventsContent.querySelectorAll('.mpa-case-details-party-item')].map((item, index) => {
      const dateElement = [...item.querySelectorAll('[id^="mpa-event-date"], .mpa-text-semi-bold')].find((node) => !node.closest('[hidden], [aria-hidden="true"]') && node.getClientRects().length > 0);
      const date = text(dateElement);
      const descriptionElement = [...item.querySelectorAll('[id^="mpa-event-"]')].find((node) => /^mpa-event-\d+$/.test(node.id));
      const description = text(descriptionElement);
      const indexText = item.innerText.match(/(?:Document\s+)?Index\s*#?\s*:?\s*(\d+)/i)?.[1] || '';
      const documents = [...item.querySelectorAll('form[action*="DownloadDocument"]')].map((form) => {
        const fields = [...form.querySelectorAll('input')];
        const sourceId = fields.find((input) => /^(?:DocumentId|DocumentKey|SourceDocumentId)$/i.test(input.name));
        const container = form.closest('.row') || form.parentElement;
        return {
          ...(sourceId?.value ? { sourceDocumentId: sourceId.value } : {}),
          downloadToken: fields.find((input) => input.name === 'DocumentDownloadToken')?.value || '',
          requestVerificationToken: fields.find((input) => input.name === '__RequestVerificationToken')?.value || '',
          pages: text(container?.querySelector('.mpa-document-total-pages')),
          title: text(container?.querySelector('.mpa-document-title')) || description,
          formAction: form.action,
          formIndex: formIndex++,
          rawText: text(container),
        };
      });
      const sourceId = item.getAttribute('data-event-id');
      return { index: index + 1, ...(sourceId ? { sourceId } : {}), date, description, indexText, documents, rawText: text(item) };
    });
    // Capture every source section, not just events: charges, dispositions, hearings,
    // financials, warrants, judgments and future section types retain their raw labels.
    const sections = [...document.querySelectorAll('[id^="mpa-roa-"][id$="-content"]')].map((section) => {
      const labelledBy = section.getAttribute('aria-labelledby');
      const heading = (labelledBy ? document.getElementById(labelledBy) : null) || section.previousElementSibling;
      return { id: section.id, label: text(heading), text: text(section) };
    });
    return { caseInfo, parties, events, sections, rawText: pageText };
  });
  const normalized = normalizeRoaSnapshot(snapshot);
  if (!normalized.caseInfo.caseNumber) throw Object.assign(new Error('Docket did not contain a case number'), { code: 'parse_error' });
  if (normalized.events.some((event) => !event.description)) throw Object.assign(new Error('Docket event title could not be identified independently of its date'), { code: 'parse_error' });
  return normalized;
}
