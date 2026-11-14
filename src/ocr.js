import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runNativeSync } from './native-tools.js';
import os from 'node:os';
import { processFilingToDossier, classifyDocumentHeading } from './nlp.js';

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

// Use the same pre-exec resource limits as acquisition/storage PDF validation.
function runTool(binary, args, maxBuffer = 16 * 1024 * 1024) {
  return runNativeSync(binary, args, { timeout: 60000, maxBuffer }).stdout;
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



/**
 * Check if a PDF page has sufficient embedded digital text.
 */
export function extractEmbeddedText(pdfPath) {
  const raw = runTool(PDFTOTEXT_PATH, ['-layout', pdfPath, '-']);
  const pages = raw.split('\f');
  if (pages.at(-1)?.trim() === '') pages.pop();
  return pages;
}
export function getPdfPageCount(pdfPath) {
  try {
    const output = runTool(PDFINFO_PATH, [pdfPath], 1024 * 1024);
    const match = output.match(/^Pages:\s+(\d+)$/mi);
    const count = match ? Number.parseInt(match[1], 10) : 0;
    if (count < 1 || count > 2000) throw new Error('PDF page count outside supported range 1–2000');
    return count;
  } catch (error) {
    throw new Error(`Unable to determine PDF page count for ${pdfPath}: ${error.message}`);
  }
}


/**
 * Perform OCR on a single scanned page image using Tesseract.
 */
export function ocrImage(imagePath) {
  return runTool(TESSERACT_PATH, [imagePath, 'stdout', '-l', 'eng'], 1024 * 1024);
}

/**
 * Render specific PDF page(s) to PNG images using pdftoppm.
 */
export function renderPageImages(pdfPath, firstPage, lastPage, dpi = 200) {
  if (!Number.isInteger(firstPage) || firstPage < 1 || lastPage !== firstPage) {
    throw new Error('Raster extraction requires exactly one positive page number');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'court-page-'));
  const prefix = path.join(directory, 'page');
  try {
    runTool(PDFTOPPM_PATH, ['-gray', '-r', String(dpi), '-scale-to', '2400',
      '-f', String(firstPage), '-l', String(lastPage), '-singlefile', pdfPath, prefix]);
    const image = `${prefix}.pgm`;
    if (!fs.existsSync(image)) throw new Error('Renderer did not produce a page image');
    return [image];
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Hybrid Text Extractor: uses embedded vector text if present, falls back to Tesseract OCR for scanned pages.
 */
export function extractPdfTextHybrid(pdfPath, options = {}) {
  const minWordsPerPage = options.minWordsPerPage ?? 35;
  const reportedPages = getPdfPageCount(pdfPath);
  const embeddedPages = extractEmbeddedText(pdfPath);
  const totalPages = reportedPages;
  if (totalPages < 1) throw new Error(`PDF has no readable pages: ${pdfPath}`);

  const finalPages = [];
  const warnings = [];
  let extractedCharacters = 0;
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const pageText = embeddedPages[pageNum - 1] || '';
    const wordCount = pageText.split(/\s+/).filter(Boolean).length;

    if (wordCount >= minWordsPerPage) {
      extractedCharacters += pageText.length;
      if (extractedCharacters > 32 * 1024 * 1024) throw new Error('PDF extracted text exceeds 32 Mi characters');
      finalPages.push({
        pageNum,
        text: pageText,
        source: 'vector_text',
        wordCount,
        quality: { status: 'text', wordCount },
      });
      continue;
    }

    let images = [];
    let ocrText = '';
    let failure = '';
    let blank = false;
    try {
      images = renderPageImages(pdfPath, pageNum, pageNum, options.dpi ?? 200);
      // PGM pixels permit a conservative genuinely-white-page distinction.
      const pixels = fs.readFileSync(images[0]);
      const header = pixels.toString('ascii', 0, 200).match(/^P5\s+(?:#[^\n]*\n\s*)*(\d+)\s+(\d+)\s+255\s/);
      if (header) {
        const raster = pixels.subarray(header[0].length);
        blank = raster.length === Number(header[1]) * Number(header[2]) && raster.every(value => value >= 250);
      }
      ocrText = ocrImage(images[0]);
    } catch (error) {
      failure = error.message;
      warnings.push(`Page ${pageNum} extraction failed: ${failure}`);
    } finally {
      for (const image of images) fs.rmSync(path.dirname(image), { recursive: true, force: true });
    }
    // Never concatenate the same vector words with their OCR duplicates.
    const text = ocrText.trim().length > pageText.trim().length ? ocrText : pageText;
    extractedCharacters += text.length;
    if (extractedCharacters > 32 * 1024 * 1024) throw new Error('PDF extracted text exceeds 32 Mi characters');
    const source = failure ? (text.trim() ? 'vector_text_sparse' : 'extraction_failed')
      : text.trim() ? (text === ocrText ? 'tesseract_ocr' : 'vector_text_sparse')
      : blank ? 'blank' : 'unreadable';
    if (source === 'unreadable') warnings.push(`Page ${pageNum} has visible content but no recognized text`);
    finalPages.push({
      pageNum,
      text,
      source,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      quality: { status: failure ? 'failed' : source === 'blank' ? 'blank' : source === 'unreadable' ? 'unreadable' : 'text',
        ...(failure ? { error: failure } : {}) },
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
  const heading = classifyDocumentHeading(fullText);
  const documentTitle = heading.evidence || null;

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
