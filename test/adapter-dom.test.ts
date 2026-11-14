import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { parseRoa } from '../src/roa.js';
import { parseSearchResults, sanitizeSourceData, waitForSearchResults } from '../src/search.js';
import { checkWafBlock } from '../src/waf.js';
import { installSourceRequestGate } from '../src/browser.js';

test('offline source-shaped DOM parsing preserves source meaning and fails closed', async (t) => {
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser = await chromium.launch({ headless: true, ...(existsSync(systemChrome) ? { executablePath: systemChrome } : {}) });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort()); // No portal or external requests in fixture tests.
    await t.test('hidden date is not title, DOM row is not docket index, and every section/attachment survives', async () => {
      await page.setContent(await readFile(new URL('./fixtures/adapters/mn-roa-observed.html', import.meta.url), 'utf8'));
      const roa = await parseRoa(page);
      assert.equal(roa.caseInfo.caseNumber, '27-CV-24-1');
      assert.equal(roa.events[0]?.description, 'Petition with exhibits');
      assert.equal(roa.events[0]?.index, 1);
      assert.equal(roa.events[0]?.indexText, '9');
      assert.equal(roa.events[0]?.date, '01/03/2024');
      assert.equal(roa.events[0]?.documents.length, 2);
      assert.equal(roa.events[1]?.hasDocument, false);
      assert.equal(roa.totalDocuments, 2);
      assert.ok(roa.sections.some((section: { label: string }) => section.label === 'Dispositions / Judgments'));
      assert.doesNotMatch(JSON.stringify(sanitizeSourceData(roa)), /secret-A|secret-B|csrf-secret|script-secret|DownloadToken/);
    });
    await t.test('unrecognized and validation-error pages are not no-result observations', async () => {
      await page.setContent('<p>The value is not valid for Hearing Date.</p>');
      await assert.rejects(parseSearchResults(page), { code: 'parse_error' });
      await assert.rejects(parseRoa(page), /missing case event section/);
    });
    await t.test('explicit no-results source notice is retained', async () => {
      await page.setContent('<p>Your search returned no results</p>');
      const result = await parseSearchResults(page);
      assert.equal(result.noResults, true);
    });
    await t.test('search cap notice remains incomplete evidence', async () => {
      await page.setContent('<p>More than 200 results; only the first 200 are displayed.</p><div id="mpaCardsWrapper"><div><h2>Case Number: 27-CV-24-1</h2><p>Case Title: Synthetic</p><a class="mpa-case-search-results-btn" href="https://publicaccess.courts.state.mn.us/CaseSearch/ViewCaseDetails?roa=fixture">Case Details</a></div></div>');
      const result = await parseSearchResults(page);
      assert.equal(result.truncated, true);
      assert.equal(result.cases[0]?.caseNumber, '27-CV-24-1');
    });
    await t.test('visible challenges stop acquisition but an unloaded CAPTCHA library does not', async () => {
      await page.setContent('<script src="https://example.invalid/recaptcha.js"></script><p>Case search</p>');
      assert.equal((await checkWafBlock(page)).blocked, false);
      await page.setContent('<div class="g-recaptcha">Verify you are human</div>');
      assert.equal((await checkWafBlock(page)).blocked, true);
    });
    await t.test('an HTTP-200-shaped challenge iframe is blocked after readiness timeout', async () => {
      await page.setContent('<iframe title="reCAPTCHA challenge" srcdoc="<p>Human check</p>"></iframe>');
      await assert.rejects(waitForSearchResults(page, 30), { code: 'blocked' });
    });
    await t.test('isolated-context gating intercepts initial popup requests without affecting another context', async () => {
      const owned = await browser.newContext({ serviceWorkers: 'block' });
      const unrelated = await browser.newContext({ serviceWorkers: 'block' });
      try {
        await owned.route('**/*', (route) => route.abort());
        await unrelated.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Unrelated fixture tab</p>' }));
        const ownerPage = await owned.newPage();
        let reserved = 0;
        const blocked = Object.assign(new Error('fixture budget denied'), { code: 'blocked' });
        const gate = await installSourceRequestGate(owned, { beforeRequest: async () => { reserved++; throw blocked; } });
        const popupUrl = 'https://publicaccess.courts.state.mn.us/CaseSearch?fixture-popup=1';
        const rejected = owned.waitForEvent('requestfailed', { predicate: (request) => request.url() === popupUrl, timeout: 5000 });
        await ownerPage.evaluate((url) => { window.open(url, '_blank'); }, popupUrl);
        await rejected;
        assert.equal(reserved, 1);
        assert.equal(gate.error, blocked);
        const unrelatedPage = await unrelated.newPage();
        await unrelatedPage.goto('https://publicaccess.courts.state.mn.us/CaseSearch?unrelated-fixture=1');
        assert.equal(reserved, 1);
        assert.equal(await unrelatedPage.textContent('p'), 'Unrelated fixture tab');
        await gate.close();
      } finally { await owned.close(); await unrelated.close(); }
    });
  } finally { await browser.close(); }
});
