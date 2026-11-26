import { CONFIG } from './config.js';
import { ensureTermsAccepted, normalizeCaseNumber, caseNumbersEqual, sleepJitter } from './waf.js';
import { COUNTIES } from './counties.js';

function resolveCounty(value) {
  const normalized = value.trim().toLowerCase();
  return COUNTIES.find((county) => [county.name, county.code, county.id].some((candidate) => String(candidate).toLowerCase() === normalized));
}

// Labels and requirements: Minnesota SCAO search quick-reference guides, 2022-08-05.
// These are documented UI contracts, not a claim of live DOM verification.
const common = ['soundex', 'county', 'counties'];
const names = ['lastName', 'firstName', 'middleName'];
const attorneys = ['attorneyLastName', 'attorneyFirstName', 'attorneyMiddleName', 'barNumber'];
const caseFilters = ['filedFrom', 'filedTo', 'status', 'categories', ...common];
export const SEARCH_MODES = {
  case: { required: ['caseNumber OR citationNumber'], optional: ['caseNumber', 'citationNumber'] },
  party: { required: ['lastName', 'firstName'], optional: [...names, 'dobFrom', 'dobTo', ...caseFilters] },
  business: { required: ['businessName'], optional: ['businessName', ...caseFilters] },
  attorney: { required: ['barNumber OR (attorneyLastName AND attorneyFirstName)'], optional: [...attorneys, ...caseFilters] },
  document: { required: ['caseNumber'], optional: ['caseNumber'] },
  hearing: { required: ['hearingFrom', 'caseNumber OR judgeName OR businessName OR (lastName AND firstName) OR attorney'], optional: ['caseNumber', 'judgeName', 'businessName', ...names, ...attorneys, 'hearingFrom', 'hearingTo', 'categories', ...common] },
  judgment: { required: ['businessName OR (lastName AND firstName)'], optional: ['businessName', ...names, 'docketedFrom', 'docketedTo', 'judgmentStatus', ...common] },
};

export function validateSearchOptions(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Search must be an object');
  const query = { ...input, searchType: input.searchType || 'case' };
  const mode = SEARCH_MODES[query.searchType];
  if (!mode) throw new Error(`Unsupported searchType: ${query.searchType}`);
  const allowed = new Set(['searchType', 'sourceId', 'acquireResults', ...mode.optional]);
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key)) throw new Error(`Field ${key} is not supported for ${query.searchType} search`);
    if (value === undefined) { delete query[key]; continue; }
    if (['soundex', 'acquireResults'].includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
    } else if (['counties', 'categories'].includes(key)) {
      if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`${key} must be a nonempty string array`);
    } else if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a nonempty string`);
  }
  if (query.county && query.counties) throw new Error('Use county or counties, not both');
  if (query.sourceId !== 'independent-fixture') {
    for (const county of query.counties || (query.county ? [query.county] : [])) if (!resolveCounty(county)) throw new Error(`Unknown county: ${county}`);
  }
  if (query.categories?.some((value) => !['CV', 'CR', 'FAM', 'PR'].includes(value))) throw new Error('Unknown case category');
  if (query.status && !['all', 'active', 'inactive', '0', '1', '2'].includes(query.status.toLowerCase())) throw new Error('Unknown case status');
  for (const prefix of ['filed', 'dob', 'hearing', 'docketed']) {
    const from = query[`${prefix}From`]; const to = query[`${prefix}To`];
    for (const date of [from, to].filter(Boolean)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error(`${prefix} date must be a valid YYYY-MM-DD date`);
    }
    if (to && !from) throw new Error(`${prefix}From is required with ${prefix}To`);
    if (from && to && from > to) throw new Error(`${prefix} date range is reversed`);
  }
  const hasPerson = !!(query.lastName || query.firstName || query.middleName);
  const hasAttorneyName = !!(query.attorneyLastName || query.attorneyFirstName || query.attorneyMiddleName);
  if (hasPerson && !(query.lastName && query.firstName)) throw new Error('Person search requires lastName and firstName');
  if (hasAttorneyName && !(query.attorneyLastName && query.attorneyFirstName)) throw new Error('Attorney name search requires attorneyLastName and attorneyFirstName');
  if (query.barNumber && hasAttorneyName) throw new Error('Use attorney name or barNumber, not both');
  if (query.barNumber && !/^[\d-]+$/.test(query.barNumber)) throw new Error('Invalid barNumber');
  if (query.soundex !== undefined && (query.barNumber || query.judgeName)) throw new Error('Sounds Like applies only to person, business, or attorney names');
  const selectors = [query.caseNumber, query.citationNumber, query.businessName, hasPerson, query.barNumber || hasAttorneyName, query.judgeName].filter(Boolean);
  if (selectors.length !== 1) throw new Error('Select exactly one case, citation, person, business, attorney, or judicial officer criterion');
  if (query.searchType === 'party' && !hasPerson) throw new Error('Person search requires firstName and lastName');
  if (query.searchType === 'business' && !query.businessName) throw new Error('Business search requires businessName');
  if (query.searchType === 'attorney' && !(query.barNumber || hasAttorneyName)) throw new Error('Attorney search requires a name or barNumber');
  if (query.searchType === 'document' && !query.caseNumber) throw new Error('Document search requires caseNumber');
  if (query.searchType === 'hearing' && !query.hearingFrom) throw new Error('Hearing search requires hearingFrom');
  if (query.searchType === 'hearing' && query.caseNumber && ['categories', 'county', 'counties', 'soundex'].some((key) => query[key] !== undefined)) throw new Error('Hearing case-number search does not support name/location/category options');
  for (const key of [...names, ...attorneys.filter((key) => key !== 'barNumber'), 'businessName']) {
    const value = query[key];
    if (!value) continue;
    if (value.includes('*') && (!/^[^*]{2,}\*$/.test(value) || query.soundex)) throw new Error('Wildcard requires at least two leading characters and cannot be combined with Sounds Like');
  }
  if ((query.caseNumber || query.citationNumber) && !/^[a-zA-Z0-9-]+$/.test(query.caseNumber || query.citationNumber)) throw new Error('Case/citation numbers must contain only letters, numbers, and hyphens');
  if (query.caseNumber && query.sourceId !== 'independent-fixture' &&
      !/^(?:\d{1,2}[A-Z]{0,2}-[A-Z]{2,4}(?:-[A-Z]{2,4})?-\d{2,4}-\d+|\d{1,2}[A-Z]{2,8}\d{3,})$/i.test(query.caseNumber)) {
    throw new Error('A complete Minnesota case number is required (county, case type, year, and sequence)');
  }
  return query;
}

export function sanitizeSourceData(value) {
  if (Array.isArray(value)) return value.map(sanitizeSourceData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/token|cookie|authorization|password|secret|session|formSelector|btnSelector/i.test(key))
    .map(([key, item]) => [key, sanitizeSourceData(item)]));
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try { const url = new URL(value); url.username = ''; url.password = ''; url.hash = ''; for (const key of [...url.searchParams.keys()]) if (/token|auth|session|signature|key|credential/i.test(key)) url.searchParams.delete(key); return url.toString(); } catch { return ''; }
  }
  return value;
}

async function assertSearchPageHealthy(page, context) {
  if (/error|service unavailable/i.test(await page.title())) throw Object.assign(new Error(`${context} returned an error page`), { code: 'retryable' });
}

function labelPattern(label) {
  return new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:*]?\\s*$`, 'i');
}
async function visible(locator, label) {
  const matches = [];
  for (const candidate of await locator.all()) if (await candidate.isVisible()) matches.push(candidate);
  if (matches.length !== 1) throw Object.assign(new Error(`Documented MCRO control "${label}" resolved to ${matches.length} visible elements; source UI needs review`), { code: 'parse_error' });
  return matches[0];
}
async function choose(page, label) {
  // These IDs were observed in the preserved MCRO session, not inferred.
  const observed = { Name: '#MpaCaseSearchNameTypeTab', Person: '#MpaCaseSearchNameTypePersonTab', Business: '#MpaCaseSearchNameTypeBusinessTab', 'Case Number': '#MpaCaseSearchCaseNumberTypeTab', 'Citation Number': '#MpaCaseSearchCitationNumberTypeTab', Attorney: '#MpaCaseSearchAttorneyTypeTab', County: '#mpaLocOptionToggleCounty' };
  if (observed[label] && await page.locator(observed[label]).isVisible()) {
    await page.locator(observed[label]).click();
    await page.waitForTimeout(300);
    return;
  }
  await (await visible(page.getByText(label, { exact: true }), label)).click();
  await page.waitForTimeout(300);
}
async function field(page, label) {
  const observed = { 'Last Name': '#LastName', 'First Name': '#FirstName', 'Middle Name': '#MiddleName', 'Sounds Like': '#Soundex', 'Enter Case Number': '#CaseSearchNumber', 'Enter Citation Number': '#CaseSearchNumber', 'Enter Attorney Bar Number': '#CaseSearchNumber', 'Judicial Officer Name': '#JudicialOfficerName', 'Case Status': '#CaseStatus', 'Judgment Status': '#JudgmentStatus' };
  if (observed[label]) {
    try {
      await page.locator(observed[label]).waitFor({ state: 'visible', timeout: 3000 });
      return page.locator(observed[label]);
    } catch {
      // Fall through to getByLabel
    }
  }
  return visible(page.getByLabel(labelPattern(label)), label);
}
async function fill(page, label, value) { if (value !== undefined) await (await field(page, label)).fill(value); }
async function dateRange(page, label, from, to) {
  if (!from) return;
  const ids = { 'Date of Birth': ['DobFrom', 'DobTo'], 'Date Filed': ['FiledDateFrom', 'FiledDateTo'], 'Hearing Date': ['HearingDateFrom', 'HearingDateTo'], 'Docketed Date': ['DocketedDateFrom', 'DocketedDateTo'] }[label];
  const choice = to && to !== from ? 'Range' : 'On';
  const observedToggle = { 'Date of Birth': `#mpaCaseSearchDobToggle${choice}`, 'Date Filed': `#mpaCaseSearchDateFiledToggle${choice}` }[label];
  if (observedToggle && await page.locator(observedToggle).count()) await page.locator(observedToggle).click();
  else {
    // Hearing/judgment toggle IDs are not assumed: discover the actual enclosing
    // group and click its documented On/Range control.
    await page.evaluate(({ fromId, choice }) => {
      const input = document.getElementById(fromId);
      let root = input?.parentElement;
      while (root && root !== document.body) {
        const controls = [...root.querySelectorAll('button, label, a')].filter((node) => node.textContent.trim() === choice);
        if (controls.length === 1) { controls[0].click(); return; }
        root = root.parentElement;
      }
      throw new Error(`Date toggle ${choice} not found for ${fromId}`);
    }, { fromId: ids[0], choice });
  }
  const input = page.locator(`#${ids[0]}`);
  const format = (date) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;
  await input.fill((await input.getAttribute('type')) === 'date' ? from : format(from));
  if (to && to !== from) {
    const upper = page.locator(`#${ids[1]}`);
    await upper.fill((await upper.getAttribute('type')) === 'date' ? to : format(to));
  }
}

async function applyQuery(page, query) {
  const mode = query.searchType;
  if (mode === 'document') { await page.locator('#CaseNumber').fill(query.caseNumber); return; }
  if (query.caseNumber || query.citationNumber) {
    const label = query.caseNumber ? 'Case Number' : 'Citation Number';
    await choose(page, label); await fill(page, `Enter ${label}`, query.caseNumber || query.citationNumber);
  } else if (query.judgeName) {
    await choose(page, 'Judicial Officer');
    const control = await field(page, 'Judicial Officer Name');
    if (await control.evaluate((node) => node.tagName === 'SELECT')) await control.selectOption({ label: query.judgeName });
    else {
      await control.fill(query.judgeName);
      const option = page.getByRole('option', { name: query.judgeName, exact: true });
      await (await visible(option, query.judgeName)).click();
    }
  } else if (query.barNumber || query.attorneyLastName) {
    await choose(page, 'Attorney'); await choose(page, query.barNumber ? 'Attorney Bar Number' : 'Attorney Name');
    if (query.barNumber) await fill(page, 'Enter Attorney Bar Number', query.barNumber);
    else { await fill(page, 'Last Name', query.attorneyLastName); await fill(page, 'First Name', query.attorneyFirstName); await fill(page, 'Middle Name', query.attorneyMiddleName); }
  } else {
    if (mode !== 'judgment') await choose(page, 'Name');
    await choose(page, query.businessName ? 'Business' : 'Person');
    if (query.businessName) {
      const control = await visible(page.getByLabel(/^(?:Enter )?Business Name\s*[:*]?\s*$/i), 'Business Name'); await control.fill(query.businessName);
    } else { await fill(page, 'Last Name', query.lastName); await fill(page, 'First Name', query.firstName); await fill(page, 'Middle Name', query.middleName); }
  }
  if (query.soundex !== undefined) await (await field(page, 'Sounds Like')).setChecked(query.soundex);
  if (mode === 'hearing') await dateRange(page, 'Hearing Date', query.hearingFrom, query.hearingTo);
  const hasAdditional = ['dobFrom', 'filedFrom', 'docketedFrom', 'status', 'judgmentStatus', 'categories', 'county', 'counties'].some((key) => query[key] !== undefined);
  if (hasAdditional) {
    const observed = page.locator('#MpaAdditionalCriteriaHeader');
    const toggle = await observed.count() ? observed : await visible(page.getByText('Additional Search Options', { exact: true }), 'Additional Search Options');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
  await dateRange(page, 'Date of Birth', query.dobFrom, query.dobTo);
  await dateRange(page, 'Date Filed', query.filedFrom, query.filedTo);
  await dateRange(page, 'Docketed Date', query.docketedFrom, query.docketedTo);
  if (query.status) {
    const statuses = { '0': 'All', '1': 'Active', '2': 'Inactive', all: 'All', active: 'Active', inactive: 'Inactive' };
    await (await field(page, 'Case Status')).selectOption({ label: statuses[query.status.toLowerCase()] });
  }
  if (query.judgmentStatus) await (await field(page, 'Judgment Status')).selectOption({ label: query.judgmentStatus });
  if (query.categories) {
    const controls = page.locator('input[name="CaseCategoryKeys"]'); // Existing source-observed group name.
    if (!(await controls.count())) throw new Error('Case category controls are absent');
    for (const control of await controls.all()) await control.setChecked(query.categories.includes(await control.getAttribute('value')));
  }
  const counties = query.counties || (query.county ? [query.county] : []);
  if (counties.length) {
    await choose(page, 'County');
    const codes = counties.map((county) => resolveCounty(county).code);
    const controls = page.locator('input[name="Locations"]');
    for (const code of codes) if (await controls.filter({ visible: true }).count() === 0 || await page.locator(`input[name="Locations"][value=${JSON.stringify(code)}]`).count() !== 1) throw new Error(`County control missing: ${code}`);
    for (const control of await controls.all()) if (await control.isVisible()) await control.setChecked(codes.includes(await control.getAttribute('value')));
  }
}

export async function waitForSearchResults(page, timeoutMs = CONFIG.delays.searchTimeoutMs) {
  try {
    await page.waitForFunction(() => {
      const text = document.body.innerText;
      return document.querySelector('#mpaCardsWrapper, form[action*="DownloadDocument"]') ||
        /Your search returned no results|No (?:cases|hearings|judgments) were found|Documents Available Online|The value .*not valid|field is required|access denied|request blocked|the requested url was rejected|verify you are human/i.test(text);
    }, undefined, { timeout: timeoutMs });
  } catch (error) {
    throw error;
  }
}

export async function executeSearch(page, input) {
  const query = validateSearchOptions(input);
  if (query.sourceId && query.sourceId !== 'mn-mcro') throw new Error('Live search accepts only the mn-mcro source');
  const endpoint = { document: CONFIG.urls.documentSearch, hearing: CONFIG.urls.hearingSearch, judgment: new URL('JudgmentSearch', CONFIG.urls.caseSearch).href }[query.searchType] || CONFIG.urls.caseSearch;
  await page.goto(endpoint, { waitUntil: 'domcontentloaded', timeout: CONFIG.delays.pageLoadTimeoutMs });
  // Let F5 client-telemetry settle before interacting, then pause like a human
  // before submitting; instant submits are a bot tell.
  await page.waitForLoadState('networkidle', { timeout: Math.min(CONFIG.delays.pageLoadTimeoutMs, 10000) }).catch(() => {});
  await assertSearchPageHealthy(page, 'Search'); await ensureTermsAccepted(page);
  await applyQuery(page, query);
  await sleepJitter();
  const buttonId = { document: '#btnFindCaseByNumber', judgment: '#btnJudgmentSearch', hearing: '#btnHearingSearch' }[query.searchType] || '#btnCaseSearch';
  await page.locator(buttonId).click();
  // MCRO changes the DOM without navigating. A navigation-only wait previously
  // timed out on successful results and misclassified invalid hearing dates.
  await waitForSearchResults(page);
  await assertSearchPageHealthy(page, 'Search results'); await ensureTermsAccepted(page);
  const validationErrors = await page.locator('.field-validation-error, .validation-summary-errors').allTextContents();
  if (validationErrors.some((text) => text.trim())) throw Object.assign(new Error(`MCRO rejected search: ${validationErrors.join('; ')}`), { code: 'permanent' });
  if (query.searchType === 'document') return parseDocumentSearchResults(page);
  const result = await parseSearchResults(page);
  if (query.caseNumber) {
    if (result.cases.some((item) => !caseNumbersEqual(item.caseNumber, query.caseNumber))) throw new Error('MCRO returned non-matching case number');
  }
  return result;
}


export async function parseSearchResults(page) {
  const result = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const wrapper = document.querySelector('#mpaCardsWrapper');
    if (!wrapper) {
      const noResults = /Your search returned no results|No cases were found|No hearings were found|No judgments were found/i.test(bodyText);
      return { totalFound: 0, noResults, unexpected: !noResults, cases: [], rawText: bodyText };
    }
    const cards = [...wrapper.children];
    const cases = cards.map((card, index) => {
      const text = card.innerText;
      const extract = (label) => text.match(new RegExp(label + ':\\s*([^\\n]+)', 'i'))?.[1]?.trim() || '';
      const heading = card.querySelector('h2, h3, h4, [class*="mpa-case-search-results-card-header"]');
      const link = card.querySelector('a.mpa-case-search-results-btn, a[href*="ViewCaseDetails"]');
      return { index: index + 1, caseNumberRaw: extract('Case Number') || heading?.innerText.replace(/Case Number:\s*/i, '').trim() || '', caseTitle: extract('Case Title'), caseType: extract('Case Type'), dateFiled: extract('Date Filed'), caseLocation: extract('Case Location'), judicialOfficer: extract('Judicial Officer'), caseStatus: extract('Case Status'), citationNumber: extract('Citation Number'), detailsHref: link?.href || null, rawText: text };
    });
    const truncated = cases.length >= 200 || /(?:first|maximum|limited to)\s+200|more than 200|too many results/i.test(bodyText);
    const hasNext = [...document.querySelectorAll('a, button')].some((node) => /^next(?: page)?$/i.test(node.textContent.trim()) && !node.hasAttribute('disabled') && node.getAttribute('aria-disabled') !== 'true');
    return { totalFound: cases.length, noResults: cases.length === 0, unexpected: cases.length === 0, truncated: truncated || hasNext, cases, rawText: bodyText };
  });
  if (result.unexpected) throw Object.assign(new Error(`MCRO search results could not be recognized at ${page.url()}`), { code: 'parse_error' });
  result.cases = result.cases.map((item) => ({ ...item, caseNumber: normalizeCaseNumber(item.caseNumberRaw) }));
  if (result.cases.some((item) => !/\d/.test(item.caseNumber))) throw Object.assign(new Error('MCRO result lacks a recognizable case number'), { code: 'parse_error' });
  return result;
}

export async function parseDocumentSearchResults(page) {
  const result = await page.evaluate(() => {
    const text = document.body.innerText;
    const extract = (label) => text.match(new RegExp(label + ':\\s*([^\\n]+)', 'i'))?.[1]?.trim() || '';
    const documents = [...document.querySelectorAll('form[action*="DownloadDocument"]')].map((form, index) => {
      const row = form.closest('.row, div.mb-2, [class*="document-item"]') || form.parentElement;
      return { index: index + 1, docTitle: row?.innerText.trim() || '', pages: row?.innerText.match(/(\d+)\s+pages?/i)?.[1] || null, rawText: row?.innerText || '' };
    });
    return { caseNumberRaw: extract('Case Number'), caseTitle: extract('Case Title'), totalDocuments: documents.length, documents, rawText: text, noResults: /Your search returned no results|No cases were found/i.test(text) };
  });
  if (!result.caseNumberRaw && !result.noResults) throw Object.assign(new Error('Document search response is unrecognized'), { code: 'parse_error' });
  return result;
}
