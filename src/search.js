import { CONFIG } from './config.js';
import { ensureTermsAccepted, checkWafBlock, normalizeCaseNumber } from './waf.js';
import { lookupCounty } from './counties.js';

/**
 * Universal Case Search covering ALL MCRO fields.
 */
export async function searchCases(page, options = {}) {
  const {
    caseNumber = '',
    citationNumber = '',
    lastName = '',
    firstName = '',
    middleName = '',
    businessName = '',
    soundex = false,
    barNumber = '',
    attorneyLastName = '',
    attorneyFirstName = '',
    dobFrom = '',
    dobTo = '',
    dobExact = true,
    filedDateFrom = '',
    filedDateTo = '',
    filedDateExact = true,
    categories = [], // ['CV', 'CR', 'FAM', 'PR']
    caseStatus = '0', // '0'|'All', '1'|'Active', '2'|'Inactive'
    counties = [], // ['Hennepin', 'Ramsey'] or ['cty-116'] or 'all'
  } = options;

  console.log('[Search] Opening MCRO Case Search...');
  await page.goto(CONFIG.urls.caseSearch, { waitUntil: 'domcontentloaded', timeout: CONFIG.delays.pageLoadTimeoutMs });
  await ensureTermsAccepted(page);

  // 1. CASE NUMBER SEARCH
  if (caseNumber) {
    console.log(`[Search] Performing Case Number search for: "${caseNumber}"`);
    const tab = page.locator('#MpaCaseSearchCaseNumberTypeTab');
    await tab.click();
    await page.waitForTimeout(500);
    await page.locator('#CaseSearchNumber').fill(caseNumber);
    return await submitSearchAndParse(page);
  }

  // 2. CITATION NUMBER SEARCH
  if (citationNumber) {
    console.log(`[Search] Performing Citation Number search for: "${citationNumber}"`);
    const tab = page.locator('#MpaCaseSearchCitationNumberTypeTab');
    await tab.click();
    await page.waitForTimeout(500);
    await page.locator('#CaseSearchNumber').fill(citationNumber);
    return await submitSearchAndParse(page);
  }

  // 3. ATTORNEY SEARCH
  if (barNumber || attorneyLastName) {
    console.log(`[Search] Performing Attorney search: Bar="${barNumber}", Name="${attorneyLastName}, ${attorneyFirstName}"`);
    const tab = page.locator('#MpaCaseSearchAttorneyTypeTab');
    await tab.click();
    await page.waitForTimeout(500);

    if (barNumber) {
      const licTab = page.locator('#MpaCaseSearchAttyTypeNameTab').nth(1);
      await licTab.click();
      await page.waitForTimeout(500);
      await page.locator('#CaseSearchNumber').fill(barNumber);
    } else {
      const nameTab = page.locator('#MpaCaseSearchAttyTypeNameTab').nth(0);
      await nameTab.click();
      await page.waitForTimeout(500);
      if (attorneyLastName) await page.locator('#LastName').fill(attorneyLastName);
      if (attorneyFirstName) await page.locator('#FirstName').fill(attorneyFirstName);
      if (soundex) {
        const sCb = page.locator('#Soundex');
        if (await sCb.isVisible()) await sCb.check();
      }
    }

    await applyAdditionalSearchOptions(page, {
      filedDateFrom,
      filedDateTo,
      filedDateExact,
      categories,
      caseStatus,
      counties,
    });

    return await submitSearchAndParse(page);
  }

  // 4. BUSINESS NAME SEARCH
  if (businessName) {
    console.log(`[Search] Performing Business Name search for: "${businessName}"`);
    const nameTab = page.locator('#MpaCaseSearchNameTypeTab');
    await nameTab.click();
    await page.waitForTimeout(500);
    const bizTab = page.locator('#MpaCaseSearchNameTypeBusinessTab');
    await bizTab.click();
    await page.waitForTimeout(500);
    await page.locator('#BusinessName').fill(businessName);

    await applyAdditionalSearchOptions(page, {
      filedDateFrom,
      filedDateTo,
      filedDateExact,
      categories,
      caseStatus,
      counties,
    });

    return await submitSearchAndParse(page);
  }

  // 5. PERSON NAME SEARCH (or general filter search if name is empty)
  console.log(`[Search] Performing Person Name search: "${lastName}, ${firstName}"`);
  const nameTab = page.locator('#MpaCaseSearchNameTypeTab');
  await nameTab.click();
  await page.waitForTimeout(500);
  const personTab = page.locator('#MpaCaseSearchNameTypePersonTab');
  await personTab.click();
  await page.waitForTimeout(500);

  if (lastName) await page.locator('#LastName').fill(lastName);
  if (firstName) await page.locator('#FirstName').fill(firstName);
  if (middleName) await page.locator('#MiddleName').fill(middleName);
  if (soundex) {
    const sCb = page.locator('#Soundex');
    if (await sCb.isVisible()) await sCb.check();
  }

  // Apply DOB if given
  if (dobFrom || dobTo) {
    await openAdditionalSearchOptions(page);
    if (!dobExact || (dobFrom && dobTo && dobFrom !== dobTo)) {
      await page.locator('#mpaCaseSearchDobToggleRange').click().catch(() => {});
      if (dobFrom) await page.locator('#DobFrom').fill(dobFrom);
      if (dobTo) await page.locator('#DobTo').fill(dobTo);
    } else {
      await page.locator('#mpaCaseSearchDobToggleOn').click().catch(() => {});
      if (dobFrom) await page.locator('#DobFrom').fill(dobFrom);
    }
  }

  await applyAdditionalSearchOptions(page, {
    filedDateFrom,
    filedDateTo,
    filedDateExact,
    categories,
    caseStatus,
    counties,
  });

  return await submitSearchAndParse(page);
}

/**
 * Apply common Additional Search Options (Date Filed, Categories, Status, Locations).
 */
async function applyAdditionalSearchOptions(page, options = {}) {
  const { filedDateFrom, filedDateTo, filedDateExact, categories = [], caseStatus, counties = [] } = options;

  const hasOptions =
    filedDateFrom ||
    filedDateTo ||
    categories.length > 0 ||
    (caseStatus && caseStatus !== '0' && caseStatus !== 'All') ||
    (counties && counties.length > 0);

  if (!hasOptions) return;

  await openAdditionalSearchOptions(page);

  // 1. Date Filed
  if (filedDateFrom || filedDateTo) {
    if (!filedDateExact || (filedDateFrom && filedDateTo && filedDateFrom !== filedDateTo)) {
      await page.locator('#mpaCaseSearchDateFiledToggleRange').click().catch(() => {});
      if (filedDateFrom) await page.locator('#FiledDateFrom').fill(filedDateFrom);
      if (filedDateTo) await page.locator('#FiledDateTo').fill(filedDateTo);
    } else {
      await page.locator('#mpaCaseSearchDateFiledToggleOn').click().catch(() => {});
      if (filedDateFrom) await page.locator('#FiledDateFrom').fill(filedDateFrom);
    }
  }

  // 2. Categories
  if (categories && categories.length > 0) {
    for (const cat of categories) {
      const code = cat.toUpperCase();
      const cb = page.locator(`input[name="CaseCategoryKeys"][value="${code}"]`);
      if (await cb.isVisible().catch(() => false)) {
        await cb.check();
      }
    }
  }

  // 3. Case Status (0: All, 1: Active, 2: Inactive)
  if (caseStatus) {
    let val = '0';
    if (caseStatus === '1' || caseStatus.toLowerCase() === 'active') val = '1';
    else if (caseStatus === '2' || caseStatus.toLowerCase() === 'inactive') val = '2';
    await page.locator('#CaseStatus').selectOption(val).catch(() => {});
  }

  // 4. Counties / Court Locations
  if (counties && counties.length > 0 && counties !== 'all') {
    await page.locator('#mpaLocOptionToggleCounty').click().catch(() => {});
    await page.waitForTimeout(500);

    const countyList = Array.isArray(counties) ? counties : [counties];
    for (const c of countyList) {
      const matched = lookupCounty(c);
      if (matched) {
        const cb = page.locator(`#${matched.id}`);
        if (await cb.isVisible().catch(() => false)) {
          await cb.check();
        } else {
          // Check by value
          const byVal = page.locator(`input[name="Locations"][value="${matched.code}"]`);
          await byVal.check().catch(() => {});
        }
      }
    }
  }
}

async function openAdditionalSearchOptions(page) {
  const advBtn = page.locator('#MpaAdditionalCriteriaHeader');
  const isExpanded = (await advBtn.getAttribute('aria-expanded')) === 'true';
  if (!isExpanded && (await advBtn.isVisible())) {
    await advBtn.click();
    await page.waitForTimeout(600);
  }
}

async function submitSearchAndParse(page) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: CONFIG.delays.searchTimeoutMs }).catch(() => {}),
    page.locator('#btnCaseSearch').click(),
  ]);
  await page.waitForTimeout(2000);
  await ensureTermsAccepted(page);

  return await parseSearchResults(page);
}

/**
 * Search Hearings by Judicial Officer, Date Range, Category, County.
 */
export async function searchHearings(page, options = {}) {
  const {
    judgeName = '',
    hearingDateFrom = '',
    hearingDateTo = '',
    hearingDateExact = true,
    categories = [],
    counties = [],
  } = options;

  console.log(`[HearingSearch] Searching: Judge="${judgeName}", Date="${hearingDateFrom}" to "${hearingDateTo}"...`);
  await page.goto(CONFIG.urls.hearingSearch, { waitUntil: 'domcontentloaded', timeout: CONFIG.delays.pageLoadTimeoutMs });
  await ensureTermsAccepted(page);

  if (judgeName) {
    const joTab = page.locator('#MpaHearingSearchJudicialOfficerTypeTab');
    await joTab.click();
    await page.waitForTimeout(500);
    await page.locator('#JudicialOfficerName').fill(judgeName);
  }

  // Hearing Date
  if (hearingDateFrom || hearingDateTo) {
    if (!hearingDateExact || (hearingDateFrom && hearingDateTo && hearingDateFrom !== hearingDateTo)) {
      await page.locator('#mpaHearingSearchHearingDateToggleRange').click().catch(() => {});
      if (hearingDateFrom) await page.locator('#HearingDateFrom').fill(hearingDateFrom);
      if (hearingDateTo) await page.locator('#HearingDateTo').fill(hearingDateTo);
    } else {
      await page.locator('#mpaHearingSearchHearingDateToggleOn').click().catch(() => {});
      if (hearingDateFrom) await page.locator('#HearingDateFrom').fill(hearingDateFrom);
    }
  }

  // Categories
  if (categories && categories.length > 0) {
    const advBtn = page.locator('#MpaAdditionalCriteriaHeader');
    if (await advBtn.isVisible()) {
      await advBtn.click();
      await page.waitForTimeout(500);
      for (const cat of categories) {
        const cb = page.locator(`input[name="CaseCategoryKeys"][value="${cat.toUpperCase()}"]`);
        if (await cb.isVisible().catch(() => false)) await cb.check();
      }
    }
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: CONFIG.delays.searchTimeoutMs }).catch(() => {}),
    page.locator('#btnHearingSearch').click(),
  ]);
  await page.waitForTimeout(2000);
  await ensureTermsAccepted(page);

  return await parseSearchResults(page);
}

/**
 * Direct DocumentSearch for Case Number.
 */
export async function searchDocumentDirect(page, caseNumber) {
  console.log(`[Search] Direct DocumentSearch for: "${caseNumber}"...`);
  await page.goto(CONFIG.urls.documentSearch, { waitUntil: 'domcontentloaded', timeout: CONFIG.delays.pageLoadTimeoutMs });
  await ensureTermsAccepted(page);

  await page.locator('#CaseNumber').fill(caseNumber);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: CONFIG.delays.searchTimeoutMs }).catch(() => {}),
    page.locator('#btnFindCaseByNumber').click(),
  ]);
  await page.waitForTimeout(2000);
  await ensureTermsAccepted(page);

  return await parseDocumentSearchResults(page);
}

/**
 * Backward compatibility helpers.
 */
export async function searchByCaseNumber(page, caseNumber) {
  return await searchCases(page, { caseNumber });
}

export async function searchByPartyName(page, options = {}) {
  return await searchCases(page, options);
}

export async function searchByAttorney(page, options = {}) {
  return await searchCases(page, {
    attorneyLastName: options.lastName,
    attorneyFirstName: options.firstName,
    barNumber: options.barNumber,
  });
}

/**
 * Parse results cards from CaseSearch.
 */
export async function parseSearchResults(page) {
  const result = await page.evaluate(() => {
    const wrapper = document.querySelector('#mpaCardsWrapper');
    if (!wrapper) {
      const bodyText = document.body.innerText;
      const noResults =
        bodyText.includes('Your search returned no results') ||
        bodyText.includes('No cases were found');
      return { totalFound: 0, noResults, cases: [] };
    }

    const cards = Array.from(wrapper.children);
    const parsed = cards.map((card, idx) => {
      const hHeading = card.querySelector('h2, h3, h4, [class*="mpa-case-search-results-card-header"]');
      const caseNumberRaw = hHeading ? hHeading.innerText.replace(/Case Number:\s*/i, '').trim() : '';

      const detailsLink = card.querySelector('a.mpa-case-search-results-btn, a[href*="ViewCaseDetails"]');
      const detailsHref = detailsLink ? detailsLink.href : null;

      const text = card.innerText;
      function extractField(label) {
        const regex = new RegExp(label + ':\\s*([^\\n]+)', 'i');
        const match = text.match(regex);
        return match ? match[1].trim() : '';
      }

      const dateFiled = extractField('Date Filed');
      const caseTitle = extractField('Case Title');
      const caseType = extractField('Case Type');
      const caseLocation = extractField('Case Location');
      const judicialOfficer = extractField('Judicial Officer');
      const caseStatus = extractField('Case Status');
      const citationNumber = extractField('Citation Number');

      return {
        index: idx + 1,
        caseNumberRaw,
        caseTitle,
        caseType,
        dateFiled,
        caseLocation,
        judicialOfficer,
        caseStatus,
        citationNumber,
        detailsHref,
        buttonSelector: `#mpaCardsWrapper > div:nth-child(${idx + 1}) a.mpa-case-search-results-btn`,
      };
    });

    return {
      totalFound: parsed.length,
      noResults: parsed.length === 0,
      cases: parsed,
    };
  });

  result.cases = result.cases.map((c) => ({
    ...c,
    caseNumber: normalizeCaseNumber(c.caseNumberRaw),
  }));

  console.log(`[Search] Found ${result.cases.length} case(s).`);
  return result;
}

export async function parseDocumentSearchResults(page) {
  return await page.evaluate(() => {
    const forms = Array.from(document.querySelectorAll('form[action*="DownloadDocument"]'));
    const pageText = document.body.innerText;

    function extractField(label) {
      const regex = new RegExp(label + ':\\s*([^\\n]+)', 'i');
      const match = pageText.match(regex);
      return match ? match[1].trim() : '';
    }

    const caseNumberRaw = extractField('Case Number');
    const caseTitle = extractField('Case Title');

    const documents = forms.map((form, idx) => {
      const parentRow = form.closest('.row, div.mb-2, [class*="document-item"]') || form.parentElement;
      const rowText = parentRow ? parentRow.innerText : '';
      const tokenInput = form.querySelector('input[name="DocumentDownloadToken"]');
      const token = tokenInput ? tokenInput.value : '';

      const pagesMatch = rowText.match(/(\d+)\s+pages?/i);
      const pages = pagesMatch ? parseInt(pagesMatch[1], 10) : null;

      const titleSpan = parentRow.querySelector('span[id*="event"], .mpa-document-title, strong');
      const docTitle = titleSpan ? titleSpan.innerText.trim() : rowText.split('\n')[0].trim();

      return {
        index: idx + 1,
        docTitle,
        pages,
        token,
        formSelector: `form[action*="DownloadDocument"]:nth-of-type(${idx + 1})`,
      };
    });

    return {
      caseNumberRaw,
      caseTitle,
      totalDocuments: documents.length,
      documents,
    };
  });
}
