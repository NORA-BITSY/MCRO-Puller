import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG } from './config.js';
import { sleepJitter } from './waf.js';

/**
 * Verify that a buffer or file is a genuine PDF (not HTML stub).
 */
export function verifyPdfBuffer(buffer) {
  if (!buffer || buffer.length < CONFIG.pdf.minBytes) {
    return {
      valid: false,
      reason: `Buffer size too small: ${buffer ? buffer.length : 0} bytes (min: ${CONFIG.pdf.minBytes})`,
    };
  }

  // Check magic bytes: %PDF (0x25, 0x50, 0x44, 0x46)
  const isPdf =
    buffer[0] === CONFIG.pdf.magicBytes[0] &&
    buffer[1] === CONFIG.pdf.magicBytes[1] &&
    buffer[2] === CONFIG.pdf.magicBytes[2] &&
    buffer[3] === CONFIG.pdf.magicBytes[3];

  if (!isPdf) {
    const preview = buffer.slice(0, 50).toString('utf-8');
    return {
      valid: false,
      reason: `Missing %PDF magic bytes. Header starts with: "${preview.replace(/[\r\n]+/g, ' ')}"`,
    };
  }

  return { valid: true };
}

/**
 * Download a single document using authenticated in-page fetch.
 */
export async function downloadDocument(page, docEvent, caseNumber) {
  const formIdx = docEvent.document.formIndex;
  console.log(`  [Downloader] Fetching doc #${docEvent.index}: "${docEvent.description}" (formIdx: ${formIdx})...`);

  // Evaluate in-page fetch with form elements
  const fetchResult = await page.evaluate(async (idx) => {
    try {
      const forms = Array.from(document.querySelectorAll('#mpa-roa-case-events-content form'));
      const form = forms[idx] || forms.find((f) => {
        const inp = f.querySelector('input[name="DocumentDownloadToken"]');
        return inp && inp.value;
      });

      if (!form) {
        return { success: false, error: 'Form element not found in DOM' };
      }

      const formData = new FormData(form);
      const resp = await fetch(form.action, {
        method: 'POST',
        body: formData,
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });

      if (!resp.ok) {
        return {
          success: false,
          status: resp.status,
          statusText: resp.statusText,
          error: `HTTP ${resp.status} ${resp.statusText}`,
        };
      }

      const disposition = resp.headers.get('content-disposition') || '';
      const contentType = resp.headers.get('content-type') || '';
      const arrayBuf = await resp.arrayBuffer();

      // Convert array buffer to base64 for safe bridge transport
      const bytes = new Uint8Array(arrayBuf);
      let binary = '';
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64 = btoa(binary);

      return {
        success: true,
        status: resp.status,
        contentType,
        disposition,
        sizeBytes: len,
        base64,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }, formIdx);

  if (!fetchResult.success) {
    throw new Error(`In-page fetch failed: ${fetchResult.error || 'Unknown error'}`);
  }

  const buffer = Buffer.from(fetchResult.base64, 'base64');
  const verify = verifyPdfBuffer(buffer);
  if (!verify.valid) {
    throw new Error(`Downloaded file failed PDF verification: ${verify.reason}`);
  }

  // Extract filename from disposition or synthesize clean filename
  let filename = '';
  const match = fetchResult.disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (match && match[1]) {
    filename = decodeURIComponent(match[1].trim());
  } else {
    const cleanDesc = (docEvent.description || 'document').replace(/[^a-zA-Z0-9_\-\.]+/g, '_');
    filename = `MCRO_${caseNumber}_${docEvent.index}_${cleanDesc}.pdf`;
  }

  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

  return {
    filename,
    buffer,
    sizeBytes: buffer.length,
    sha256,
  };
}

/**
 * Download all available documents from an ROA and organize them on disk.
 */
export async function downloadAllCaseDocuments(page, roaData, options = {}) {
  const caseNumber = roaData.caseInfo.caseNumber || 'UNKNOWN_CASE';
  const targetDir = options.outputDir || path.join(CONFIG.outputDir, caseNumber);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const docEvents = roaData.events.filter((e) => e.hasDocument);
  console.log(`[Downloader] Starting download of ${docEvents.length} document(s) for case ${caseNumber}...`);
  console.log(`[Downloader] Target directory: ${targetDir}`);

  const results = {
    caseNumber,
    caseTitle: roaData.caseInfo.caseTitle,
    caseType: roaData.caseInfo.caseType,
    dateFiled: roaData.caseInfo.dateFiled,
    totalDocuments: docEvents.length,
    downloaded: [],
    skipped: [],
    failures: [],
    startedAt: new Date().toISOString(),
  };

  for (let i = 0; i < docEvents.length; i++) {
    const docEvent = docEvents[i];
    console.log(`\n--- Document [${i + 1}/${docEvents.length}]: ${docEvent.description} ---`);

    // Determine target filename pattern to check if already downloaded
    const cleanDesc = (docEvent.description || 'document').replace(/[^a-zA-Z0-9_\-\.]+/g, '_');
    const existingFiles = fs.readdirSync(targetDir);
    const matchedExisting = existingFiles.find(
      (f) => f.includes(caseNumber) && f.includes(cleanDesc) && f.endsWith('.pdf')
    );

    if (matchedExisting && !options.force) {
      const fullPath = path.join(targetDir, matchedExisting);
      const stats = fs.statSync(fullPath);
      if (stats.size >= CONFIG.pdf.minBytes) {
        console.log(`  [Skip] Already exists and verified: ${matchedExisting} (${stats.size} bytes)`);
        results.skipped.push({
          index: docEvent.index,
          description: docEvent.description,
          filename: matchedExisting,
          sizeBytes: stats.size,
        });
        continue;
      }
    }

    // Download with retry
    let downloadedDoc = null;
    let lastError = null;

    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
      try {
        downloadedDoc = await downloadDocument(page, docEvent, caseNumber);
        break; // Success!
      } catch (err) {
        lastError = err;
        console.warn(`  [Retry ${attempt}/${CONFIG.maxRetries}] Failed to download: ${err.message}`);
        if (attempt < CONFIG.maxRetries) {
          const backoff = 2000 * Math.pow(2, attempt);
          console.log(`  [Retry] Backing off for ${backoff}ms...`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    if (downloadedDoc) {
      const filePath = path.join(targetDir, downloadedDoc.filename);
      fs.writeFileSync(filePath, downloadedDoc.buffer);
      console.log(`  [Saved] ${downloadedDoc.filename} (${downloadedDoc.sizeBytes} bytes, SHA-256: ${downloadedDoc.sha256.slice(0, 12)}...)`);

      results.downloaded.push({
        index: docEvent.index,
        date: docEvent.date,
        description: docEvent.description,
        pages: docEvent.document.pages,
        filename: downloadedDoc.filename,
        sizeBytes: downloadedDoc.sizeBytes,
        sha256: downloadedDoc.sha256,
        savedPath: filePath,
      });

      // Humanized jitter pause before next download to keep WAF safe
      if (i < docEvents.length - 1) {
        const jitter = await sleepJitter();
        console.log(`  [WAF Safe] Pausing ${Math.round(jitter / 1000)}s before next document...`);
      }
    } else {
      console.error(`  [FAILED] Document #${docEvent.index} (${docEvent.description}): ${lastError.message}`);
      results.failures.push({
        index: docEvent.index,
        description: docEvent.description,
        error: lastError.message,
      });
    }
  }

  results.finishedAt = new Date().toISOString();

  // Write docket-export-index.json
  const indexPath = path.join(targetDir, 'docket-export-index.json');
  fs.writeFileSync(indexPath, JSON.stringify(results, null, 2), 'utf-8');

  // Write human-readable README.txt
  const readmeLines = [
    `MCRO Case Docket Export`,
    `==============================================`,
    `Case Number:   ${results.caseNumber}`,
    `Case Title:    ${results.caseTitle}`,
    `Case Type:     ${results.caseType}`,
    `Date Filed:    ${results.dateFiled}`,
    `Exported At:   ${results.finishedAt}`,
    `Total Files:   ${results.downloaded.length} downloaded, ${results.skipped.length} skipped, ${results.failures.length} failed.`,
    `==============================================\n`,
    `Downloaded Documents:`,
    ...results.downloaded.map(
      (d) => `  - [${d.date}] ${d.description} -> ${d.filename} (${d.sizeBytes} bytes, ${d.pages || 'N/A'})`
    ),
  ];
  if (results.failures.length > 0) {
    readmeLines.push(
      `\nFailures:`,
      ...results.failures.map((f) => `  - Document #${f.index} (${f.description}): ${f.error}`)
    );
  }
  fs.writeFileSync(path.join(targetDir, 'README.txt'), readmeLines.join('\n'), 'utf-8');

  console.log(`\n[Downloader] Complete: ${results.downloaded.length} saved, ${results.skipped.length} skipped, ${results.failures.length} failed.`);
  console.log(`[Downloader] Index written to ${indexPath}`);

  return results;
}
