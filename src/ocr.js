import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { processFilingToDossier } from './nlp.js';

const TESSERACT_PATH = fs.existsSync('/opt/homebrew/bin/tesseract')
  ? '/opt/homebrew/bin/tesseract'
  : 'tesseract';

const PDFTOTEXT_PATH = fs.existsSync('/opt/homebrew/bin/pdftotext')
  ? '/opt/homebrew/bin/pdftotext'
  : 'pdftotext';

const PDFTOPPM_PATH = fs.existsSync('/opt/homebrew/bin/pdftoppm')
  ? '/opt/homebrew/bin/pdftoppm'
  : 'pdftoppm';
const PDFINFO_PATH = fs.existsSync('/opt/homebrew/bin/pdfinfo')
  ? '/opt/homebrew/bin/pdfinfo'
  : 'pdfinfo';
function writeFileAtomic(filePath, contents) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, contents);
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}



/**
 * Check if a PDF page has sufficient embedded digital text.
 */
export function extractEmbeddedText(pdfPath) {
  try {
    const raw = execFileSync(PDFTOTEXT_PATH, [pdfPath, '-'], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    const pages = raw.split('\f'); // Form feed separates pages in pdftotext
    if (pages.length > 0 && pages[pages.length - 1].trim() === '') {
      pages.pop();
    }
    return pages;
  } catch (err) {
    return [];
  }
}
export function getPdfPageCount(pdfPath) {
  try {
    const output = execFileSync(PDFINFO_PATH, [pdfPath], {
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024,
    });
    const match = output.match(/^Pages:\s+(\d+)$/mi);
    return match ? Number.parseInt(match[1], 10) : 0;
  } catch (error) {
    throw new Error(`Unable to determine PDF page count for ${pdfPath}: ${error.message}`);
  }
}


/**
 * Perform OCR on a single scanned page image using Tesseract.
 */
export function ocrImage(imagePath) {
  const tmpOut = path.join(os.tmpdir(), `mcro_ocr_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  try {
    execFileSync(TESSERACT_PATH, [imagePath, tmpOut], { stdio: 'pipe' });
    const txtPath = `${tmpOut}.txt`;
    if (fs.existsSync(txtPath)) {
      const text = fs.readFileSync(txtPath, 'utf-8');
      try { fs.unlinkSync(txtPath); } catch (e) {}
      return text;
    }
    return '';
  } catch (err) {
    console.warn(`[OCR] Tesseract error on ${imagePath}: ${err.message}`);
    return '';
  }
}

/**
 * Render specific PDF page(s) to PNG images using pdftoppm.
 */
export function renderPageImages(pdfPath, firstPage, lastPage, dpi = 200) {
  const tmpPrefix = path.join(os.tmpdir(), `mcro_page_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  try {
    execFileSync(
      PDFTOPPM_PATH,
      ['-png', '-r', String(dpi), '-f', String(firstPage), '-l', String(lastPage), pdfPath, tmpPrefix],
      { stdio: 'pipe' }
    );
    const dir = path.dirname(tmpPrefix);
    const base = path.basename(tmpPrefix);
    const matches = fs.readdirSync(dir).filter((f) => f.startsWith(base) && f.endsWith('.png'));
    matches.sort();
    return matches.map((f) => path.join(dir, f));
  } catch (err) {
    console.warn(`[OCR] pdftoppm error on ${pdfPath}: ${err.message}`);
    return [];
  }
}

/**
 * Hybrid Text Extractor: uses embedded vector text if present, falls back to Tesseract OCR for scanned pages.
 */
export function extractPdfTextHybrid(pdfPath, options = {}) {
  const minWordsPerPage = options.minWordsPerPage || 35;
  const embeddedPages = extractEmbeddedText(pdfPath);
  const reportedPages = getPdfPageCount(pdfPath);
  const totalPages = Math.max(reportedPages, embeddedPages.length);
  if (totalPages < 1) throw new Error(`PDF has no readable pages: ${pdfPath}`);

  const finalPages = [];
  const warnings = [];
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const pageText = embeddedPages[pageNum - 1] || '';
    const wordCount = pageText.split(/\s+/).filter(Boolean).length;

    if (wordCount >= minWordsPerPage) {
      finalPages.push({
        pageNum,
        text: pageText,
        source: 'vector_text',
        wordCount,
      });
      continue;
    }

    const images = renderPageImages(pdfPath, pageNum, pageNum, options.dpi || 200);
    let ocrText = '';
    try {
      if (images.length > 0) ocrText = ocrImage(images[0]);
    } finally {
      for (const image of images) {
        try { fs.unlinkSync(image); } catch {}
      }
    }

    const combinedText = [pageText.trim(), ocrText.trim()].filter(Boolean).join('\n\n');
    const combinedWordCount = combinedText.split(/\s+/).filter(Boolean).length;
    const source = ocrText
      ? (pageText.trim() ? 'vector_text+tesseract_ocr' : 'tesseract_ocr')
      : (pageText.trim() ? 'vector_text_sparse' : 'extraction_failed');
    if (!combinedText) warnings.push(`Page ${pageNum} produced no vector text or OCR text`);

    finalPages.push({
      pageNum,
      text: combinedText,
      source,
      wordCount: combinedWordCount,
    });
  }

  const fullText = finalPages.map((page) => page.text).join('\n\n--- Page Break ---\n\n');
  return {
    pdfPath,
    totalPages,
    pages: finalPages,
    fullText,
    warnings,
    structured: parseStructuredLegalEntities(fullText),
  };
}

/**
 * Extract structured legal entities from raw document text.
 */
export function parseStructuredLegalEntities(fullText) {
  const lines = fullText.split('\n').map((l) => l.trim()).filter(Boolean);

  // 1. Caption & Case Number
  const caseNoMatch = fullText.match(/(\d{1,2}[A-Z]{0,2}-[A-Z]{2,4}(?:-[A-Z]{2,4})?-\d{2,4}-\d+)/i);
  const caseNumber = caseNoMatch ? caseNoMatch[1].toUpperCase() : null;

  // 2. County / District
  const countyMatch = fullText.match(/COUNTY OF[ \t]+([A-Z][A-Z ]{1,40})(?=\r?\n|$)/i);
  const county = countyMatch ? countyMatch[1].trim() : null;
  const districtMatch = fullText.match(/([A-Z0-9]+)\s+JUDICIAL DISTRICT/i);
  const judicialDistrict = districtMatch ? districtMatch[1].trim() : null;

  // 3. Document Title (e.g. COMPLAINT, SUMMONS, AFFIDAVIT, NOTICE, ORDER)
  const docTitleRegex = /\b(COMPLAINT|SUMMONS|AFFIDAVIT OF [A-Z\s]+|NOTICE OF [A-Z\s]+|CIVIL COVER SHEET|ORDER FOR [A-Z\s]+|ANSWER AND COUNTERCLAIM|MOTION FOR [A-Z\s]+|PETITION FOR [A-Z\s]+)\b/i;
  const titleMatch = fullText.match(docTitleRegex);
  const documentTitle = titleMatch ? titleMatch[1].trim().toUpperCase() : null;

  // 4. Bar Numbers & Attorneys (MN License format e.g. "Atty Reg. No. 0392011" or "Bar No. 0123456")
  const barNumbers = [];
  const barMatches = fullText.matchAll(/(?:Bar|Atty|License|Reg\.?)\s*(?:No\.?|Number|#)?\s*[:#]?\s*([0-9]{7}|[0-9]{6})/gi);
  for (const m of barMatches) {
    if (!barNumbers.includes(m[1])) barNumbers.push(m[1]);
  }

  // 5. Case Type
  const caseTypeMatch = fullText.match(/Case Type:\s*([^\n\r]+)/i);
  const caseType = caseTypeMatch ? caseTypeMatch[1].trim() : null;

  // 6. Numbered Paragraphs / Allegations (e.g., "1.", "2.", "COUNT I")
  const numberedClauses = [];
  const clauseRegex = /^(?:(\d+)\.|\b(COUNT\s+[IVXLCDM]+)\b)(.+)$/gm;
  let match;
  while ((match = clauseRegex.exec(fullText)) !== null) {
    numberedClauses.push({
      header: match[1] ? `§${match[1]}` : match[2],
      snippet: match[3].slice(0, 200).trim(),
    });
    if (numberedClauses.length >= 50) break; // cap sample
  }

  return {
    caseNumber,
    county,
    judicialDistrict,
    caseType,
    documentTitle,
    barNumbers,
    clausesFound: numberedClauses.length,
    clausesSample: numberedClauses.slice(0, 10),
  };
}

/**
 * Process and save text and structured metadata alongside the PDF.
 */
export function preprocessPdf(pdfPath, options = {}) {
  if (!fs.existsSync(pdfPath) || !fs.statSync(pdfPath).isFile()) {
    throw new Error(`PDF file not found: ${pdfPath}`);
  }

  const pdfBuffer = fs.readFileSync(pdfPath);
  const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  const result = extractPdfTextHybrid(pdfPath, options);
  const baseName = pdfPath.replace(/\.pdf$/i, '');
  const txtPath = `${baseName}.txt`;
  const jsonPath = `${baseName}.dossier.json`;
  const documentId = options.documentId || sha256.slice(0, 24);

  const dossier = processFilingToDossier(result.fullText, {
    caseNumber: options.caseNumber || result.structured.caseNumber,
    documentId,
    filename: path.basename(pdfPath),
    sha256,
    sizeBytes: pdfBuffer.length,
    totalPages: result.totalPages,
    filedDate: options.filedDate || '',
    sourceIndex: options.index || null,
  });

  dossier.pageBreakdown = result.pages.map((page) => ({
    pageNum: page.pageNum,
    source: page.source,
    wordCount: page.wordCount,
  }));
  dossier.extractionWarnings = result.warnings;

  writeFileAtomic(txtPath, result.fullText);
  writeFileAtomic(jsonPath, `${JSON.stringify(dossier, null, 2)}\n`);

  console.log(
    `  [NLP & OCR] Processed ${path.basename(pdfPath)} -> .txt (${result.fullText.length} chars) & .dossier.json (${dossier.llmContext.chunks.length} chunks)`
  );
  return { ...result, dossier };
}
