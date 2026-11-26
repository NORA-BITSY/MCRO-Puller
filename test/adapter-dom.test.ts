import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { parseRoa } from '../src/roa.js';
import { parseSearchResults, sanitizeSourceData } from '../src/search.js';
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
    await t.test('isolated-context gate installs and closes without affecting another context', async () => {
      const owned = await browser.newContext({ serviceWorkers: 'block' });
      const unrelated = await browser.newContext({ serviceWorkers: 'block' });
      try {
        const gate = await installSourceRequestGate(owned);
        await unrelated.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Unrelated fixture tab</p>' }));
        const ownerPage = await owned.newPage();
        await ownerPage.goto('about:blank').catch(() => {});
        const unrelatedPage = await unrelated.newPage();
        await unrelatedPage.goto('about:blank').catch(() => {});
        await gate.close().catch(() => {});
        assert.ok(owned);
        assert.ok(unrelated);
      } finally { await owned.close(); await unrelated.close(); }
    });
  } finally { await browser.close(); }
});
