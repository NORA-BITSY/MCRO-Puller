import { CONFIG } from './config.js';
import { ensureTermsAccepted, checkWafBlock, normalizeCaseNumber } from './waf.js';

/**
 * Navigate to Case Details (ROA) from a search results card or direct URL.
 */
export async function navigateToCaseDetails(page, caseItem) {
  console.log(`[ROA] Navigating to Case Details for ${caseItem.caseNumber || caseItem.caseNumberRaw}...`);

  if (caseItem.detailsHref) {
    await page.goto(caseItem.detailsHref, { waitUntil: 'domcontentloaded', timeout: CONFIG.delays.pageLoadTimeoutMs });
  } else if (caseItem.buttonSelector) {
    const btn = page.locator(caseItem.buttonSelector).first();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: CONFIG.delays.pageLoadTimeoutMs }).catch(() => {}),
      btn.click(),
    ]);
  } else {
    throw new Error('Neither detailsHref nor buttonSelector available for case item.');
  }

  await page.waitForTimeout(1500);
  await ensureTermsAccepted(page);

  const isRoa = await page.evaluate(() => !!document.querySelector('#mpa-roa-case-events-content'));
  if (!isRoa) {
    // Check if collapsed or still loading
    await page.waitForSelector('#mpa-roa-case-events-header, #mpa-roa-case-events-content', { timeout: 10000 }).catch(() => {});
  }

  return await parseRoa(page);
}

/**
 * Parse the full ROA view into structured JSON.
 */
export async function parseRoa(page) {
  const roaData = await page.evaluate(() => {
    // 1. Case Information
    const pageText = document.body.innerText;
    function extractField(label) {
      const regex = new RegExp(label + ':\\s*([^\\n]+)', 'i');
      const match = pageText.match(regex);
      return match ? match[1].trim() : '';
    }

    const caseInfo = {
      caseNumberRaw: extractField('Case Number'),
      caseTitle: extractField('Case Title'),
      caseType: extractField('Case Type'),
      dateFiled: extractField('Date Filed'),
      caseLocation: extractField('Case Location'),
      judicialOfficer: extractField('Judicial Officer'),
      caseStatus: extractField('Case Status'),
    };

    // 2. Party Information
    const partiesContent = document.querySelector('#mpa-roa-case-parties-content');
    const parties = [];
    if (partiesContent) {
      const items = partiesContent.querySelectorAll('.mpa-case-details-party-item, .row');
      items.forEach((item) => {
        const text = item.innerText.trim();
        if (text && !parties.includes(text)) {
          parties.push(text);
        }
      });
    }

    // 3. Case Events / Documents
    const eventsContent = document.querySelector('#mpa-roa-case-events-content');
    const events = [];
    if (eventsContent) {
      const eventItems = eventsContent.querySelectorAll('.mpa-case-details-party-item');
      eventItems.forEach((item, idx) => {
        // Date
        const dateSpan = item.querySelector('.mpa-text-semi-bold, [id^="mpa-event-date"]');
        const date = dateSpan ? dateSpan.innerText.trim() : '';

        // Description
        const descSpan = item.querySelector('[id^="mpa-event-"]');
        const description = descSpan ? descSpan.innerText.trim() : '';

        // Index #
        const indexSpan = item.querySelector('.mpa-case-event-text-wrapper span');
        const indexText = indexSpan ? indexSpan.innerText.trim() : '';

        // Document Form
        const form = item.querySelector('form[action*="DownloadDocument"]');
        let documentInfo = null;

        if (form) {
          const tokenInput = form.querySelector('input[name="DocumentDownloadToken"]');
          const token = tokenInput ? tokenInput.value : '';
          const verificationInput = form.querySelector('input[name="__RequestVerificationToken"]');
          const requestVerificationToken = verificationInput ? verificationInput.value : '';

          const pagesSpan = item.querySelector('.mpa-document-total-pages');
          const pages = pagesSpan ? pagesSpan.innerText.trim() : '';

          documentInfo = {
            hasDocument: true,
            downloadToken: token,
            requestVerificationToken,
            pages,
            formAction: form.action,
            formIndex: idx,
            btnSelector: `#mpa-roa-case-events-content .mpa-case-details-party-item:nth-of-type(${idx + 1}) button.btn-mpa-download-document`,
          };
        }

        events.push({
          index: idx + 1,
          date,
          description,
          indexText,
          hasDocument: !!documentInfo,
          document: documentInfo,
        });
      });
    }

    return {
      caseInfo,
      partiesCount: parties.length,
      parties,
      totalEvents: events.length,
      documentEventsCount: events.filter((e) => e.hasDocument).length,
      events,
    };
  });

  roaData.caseInfo.caseNumber = normalizeCaseNumber(roaData.caseInfo.caseNumberRaw);
  console.log(
    `[ROA] Parsed ${roaData.caseInfo.caseNumber}: ${roaData.totalEvents} events, ${roaData.documentEventsCount} document(s).`
  );
  return roaData;
}
