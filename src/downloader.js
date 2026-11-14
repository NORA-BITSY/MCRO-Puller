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

  const tail = buffer.subarray(Math.max(0, buffer.length - 4096)).toString('latin1');
  if (!tail.includes('%%EOF')) {
    return { valid: false, reason: 'Missing PDF end-of-file marker (%%EOF)' };
  }

  return { valid: true };
}

function sanitizeFilenamePart(value, fallback = 'document', maxLength = 120) {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9_.-]+/g, '_')
    .replace(/^[_ .-]+|[_ .-]+$/g, '')
    .slice(0, maxLength);
  return cleaned || fallback;
}

function writeFileAtomic(filePath, contents) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, contents);
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

export function createDocumentKey(docEvent) {
  const identity = [
    docEvent.indexText || '',
    docEvent.date || '',
    docEvent.description || '',
    docEvent.document?.pages || '',
    docEvent.index || '',
  ].join('\u001f');
  return crypto.createHash('sha256').update(identity).digest('hex');
}

function loadExistingManifest(targetDir) {
  const indexPath = path.join(targetDir, 'docket-export-index.json');
  if (!fs.existsSync(indexPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    throw new Error(`Existing manifest is invalid: ${indexPath}: ${error.message}`);
  }
}

function verifyExistingDocument(filePath, expectedSha256) {
  if (!fs.existsSync(filePath)) return null;
  const buffer = fs.readFileSync(filePath);
  const verification = verifyPdfBuffer(buffer);
  if (!verification.valid) return null;
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (expectedSha256 && sha256 !== expectedSha256) return null;
  return { sizeBytes: buffer.length, sha256 };
}

function filenameFromDisposition(disposition, fallback) {
  const match = disposition.match(/filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?/i);
  if (!match?.[1]) return fallback;
  try {
    return decodeURIComponent(match[1].trim());
  } catch {
    return match[1].trim();
  }
}

/**
 * Download a single document using the browser context's authenticated request
 * client. The PDF bytes stay outside the page/Node serialization bridge.
 */
export async function downloadDocument(page, docEvent, caseNumber) {
  const documentKey = createDocumentKey(docEvent);
  console.log(`  [Downloader] Fetching doc #${docEvent.index}: \"${docEvent.description}\"...`);

  const formData = await page.evaluate(({ downloadToken, formIndex }) => {
    const forms = Array.from(document.querySelectorAll('#mpa-roa-case-events-content form[action*=\"DownloadDocument\"]'));
    const form = forms.find((candidate) => {
      const input = candidate.querySelector('input[name=\"DocumentDownloadToken\"]');
      return downloadToken && input?.value === downloadToken;
    }) || forms[formIndex];

    if (!form) return null;
    return {
      action: form.action,
      fields: Array.from(new FormData(form).entries()).map(([name, value]) => [name, String(value)]),
    };
  }, {
    downloadToken: docEvent.document.downloadToken,
    formIndex: docEvent.document.formIndex,
  });

  if (!formData?.action) {
    throw new Error('Document download form was not found in the current docket');
  }

  const body = new URLSearchParams();
  for (const [name, value] of formData.fields) body.append(name, value);

  const response = await page.request.post(formData.action, {
    data: body.toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-requested-with': 'XMLHttpRequest',
    },
    timeout: CONFIG.delays.downloadTimeoutMs,
  });

  try {
    if (!response.ok()) {
      throw new Error(`HTTP ${response.status()} ${response.statusText()}`);
    }

    const buffer = await response.body();
    const verification = verifyPdfBuffer(buffer);
    if (!verification.valid) {
      throw new Error(`Downloaded file failed PDF verification: ${verification.reason}`);
    }

    const headers = response.headers();
    const fallback = sanitizeFilenamePart(docEvent.description, 'document');
    const sourceFilename = filenameFromDisposition(headers['content-disposition'] || '', fallback);
    const sourceStem = sanitizeFilenamePart(path.basename(sourceFilename).replace(/\.pdf$/i, ''), fallback);
    const safeCase = sanitizeFilenamePart(caseNumber, 'UNKNOWN_CASE', 40);
    const filename = `MCRO_${safeCase}_${documentKey.slice(0, 16)}_${sourceStem}.pdf`;
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    return {
      documentKey,
      filename,
      buffer,
      sizeBytes: buffer.length,
      sha256,
    };
  } finally {
    await response.dispose();
  }
}

/**
 * Download all available documents from an ROA and organize them on disk.
 */
export async function downloadAllCaseDocuments(page, roaData, options = {}) {
  const caseNumber = roaData.caseInfo.caseNumber || 'UNKNOWN_CASE';
  const targetDir = options.outputDir || path.join(CONFIG.outputDir, caseNumber);
  fs.mkdirSync(targetDir, { recursive: true });

  const priorManifest = loadExistingManifest(targetDir);
  const priorDocuments = new Map(
    (priorManifest?.documents || [])
      .filter((document) => document.documentKey)
      .map((document) => [document.documentKey, document])
  );
  const docEvents = roaData.events.filter((event) => event.hasDocument);

  console.log(`[Downloader] Starting download of ${docEvents.length} document(s) for case ${caseNumber}...`);
  console.log(`[Downloader] Target directory: ${targetDir}`);

  const results = {
    schemaVersion: '2.0.0',
    caseNumber,
    caseTitle: roaData.caseInfo.caseTitle,
    caseType: roaData.caseInfo.caseType,
    caseStatus: roaData.caseInfo.caseStatus,
    dateFiled: roaData.caseInfo.dateFiled,
    caseLocation: roaData.caseInfo.caseLocation,
    judicialOfficer: roaData.caseInfo.judicialOfficer,
    parties: roaData.parties || [],
    totalDocuments: docEvents.length,
    documents: [],
    downloaded: [],
    skipped: [],
    failures: [],
    startedAt: new Date().toISOString(),
  };

  for (let i = 0; i < docEvents.length; i++) {
    const docEvent = docEvents[i];
    const documentKey = createDocumentKey(docEvent);
    const previous = priorDocuments.get(documentKey);
    console.log(`\n--- Document [${i + 1}/${docEvents.length}]: ${docEvent.description} ---`);

    if (previous?.filename && !options.force) {
      const existingPath = path.join(targetDir, path.basename(previous.filename));
      const verified = verifyExistingDocument(existingPath, previous.sha256);
      if (verified) {
        const record = {
          ...previous,
          index: docEvent.index,
          indexText: docEvent.indexText,
          date: docEvent.date,
          description: docEvent.description,
          pages: docEvent.document.pages,
          documentKey,
          filename: path.basename(previous.filename),
          savedPath: existingPath,
          ...verified,
        };
        console.log(`  [Skip] Verified existing document: ${record.filename} (${record.sizeBytes} bytes)`);
        results.documents.push(record);
        results.skipped.push(record);
        continue;
      }
      console.warn(`  [Repair] Existing manifest entry is missing, corrupt, or hash-mismatched; re-downloading.`);
    }

    let downloadedDoc = null;
    let lastError = null;
    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
      try {
        downloadedDoc = await downloadDocument(page, docEvent, caseNumber);
        break;
      } catch (error) {
        lastError = error;
        console.warn(`  [Retry ${attempt}/${CONFIG.maxRetries}] Failed to download: ${error.message}`);
        if (attempt < CONFIG.maxRetries) {
          const backoff = 2000 * (2 ** (attempt - 1));
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }

    if (downloadedDoc) {
      const filePath = path.join(targetDir, downloadedDoc.filename);
      writeFileAtomic(filePath, downloadedDoc.buffer);
      const record = {
        documentKey,
        index: docEvent.index,
        indexText: docEvent.indexText,
        date: docEvent.date,
        description: docEvent.description,
        pages: docEvent.document.pages,
        filename: downloadedDoc.filename,
        sizeBytes: downloadedDoc.sizeBytes,
        sha256: downloadedDoc.sha256,
        savedPath: filePath,
      };
      results.documents.push(record);
      results.downloaded.push(record);
      console.log(`  [Saved] ${record.filename} (${record.sizeBytes} bytes, SHA-256: ${record.sha256.slice(0, 12)}...)`);

      if (i < docEvents.length - 1) {
        const jitter = await sleepJitter();
        console.log(`  [Rate Limit] Pausing ${Math.round(jitter / 1000)}s before next document...`);
      }
    } else {
      const error = lastError?.message || 'Unknown download error';
      console.error(`  [FAILED] Document #${docEvent.index} (${docEvent.description}): ${error}`);
      results.failures.push({
        documentKey,
        index: docEvent.index,
        date: docEvent.date,
        description: docEvent.description,
        error,
      });
    }
  }

  results.finishedAt = new Date().toISOString();
  const indexPath = path.join(targetDir, 'docket-export-index.json');
  results.indexPath = indexPath;
  writeFileAtomic(indexPath, `${JSON.stringify(results, null, 2)}\n`);

  const readmeLines = [
    'MCRO Case Docket Export',
    '==============================================',
    `Case Number:   ${results.caseNumber}`,
    `Case Title:    ${results.caseTitle}`,
    `Case Type:     ${results.caseType}`,
    `Date Filed:    ${results.dateFiled}`,
    `Exported At:   ${results.finishedAt}`,
    `Total Files:   ${results.documents.length} verified, ${results.downloaded.length} downloaded this run, ${results.failures.length} failed.`,
    '==============================================',
    '',
    'Verified Documents:',
    ...results.documents.map(
      (document) => `  - [${document.date}] ${document.description} -> ${document.filename} (${document.sizeBytes} bytes, ${document.pages || 'N/A'})`
    ),
  ];
  if (results.failures.length > 0) {
    readmeLines.push(
      '',
      'Failures:',
      ...results.failures.map((failure) => `  - Document #${failure.index} (${failure.description}): ${failure.error}`)
    );
  }
  writeFileAtomic(path.join(targetDir, 'README.txt'), `${readmeLines.join('\n')}\n`);

  console.log(`\n[Downloader] Complete: ${results.downloaded.length} saved, ${results.skipped.length} verified existing, ${results.failures.length} failed.`);
  console.log(`[Downloader] Index written to ${indexPath}`);
  return results;
}

