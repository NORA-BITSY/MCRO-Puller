import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createCaseDossierTemplate, createFilingDossierTemplate } from './models.js';
function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}


/**
 * Classify document type from text and title.
 */
export function classifyDocumentType(text, filename = '') {
  return classifyDocumentHeading(text, filename).label;
}

const DOCUMENT_FAMILIES = {
  AFFIDAVIT_OF_SERVICE: 'AFFIDAVIT', CIVIL_COVER_SHEET: 'ADMINISTRATIVE',
  NOTICE_OF_CASE_FILING: 'NOTICE', NOTICE_OF_DEFICIENCY: 'NOTICE',
  SUMMONS_AND_COMPLAINT: 'PLEADING', COMPLAINT: 'PLEADING', ANSWER: 'PLEADING',
  SUMMONS: 'NOTICE',
};

export function classifyDocumentHeading(text, filename = '') {
  /** @type {Array<[string, RegExp]>} */
  const rules = [
    ['AFFIDAVIT_OF_SERVICE', /^(?:AFFIDAVIT|CERTIFICATE) OF SERVICE\b/],
    ['CIVIL_COVER_SHEET', /^CIVIL COVER SHEET\b/],
    ['NOTICE_OF_CASE_FILING', /^NOTICE OF CASE FILING\b/],
    ['NOTICE_OF_DEFICIENCY', /^NOTICE OF DEFICIENCY\b/],
    ['SUMMONS_AND_COMPLAINT', /^SUMMONS AND COMPLAINT\b/],
    ['ANSWER', /^(?:(?:DEFENDANT|RESPONDENT)(?:'S|S')?\s+)?ANSWER\b/],
    ['MOTION', /^(?:(?:PLAINTIFF|DEFENDANT)(?:'S|S')?\s+)?MOTION\b/],
    ['ORDER', /^(?:PROPOSED\s+)?ORDER\b/],
    ['JUDGMENT', /^JUDGMENT\b/],
    ['SUMMONS', /^SUMMONS\b/],
    ['COMPLAINT', /^(?:(?:FIRST|SECOND|THIRD|VERIFIED|AMENDED)\s+)*(?:COMPLAINT|PETITION)\b/],
    ['AFFIDAVIT', /^AFFIDAVIT\b/],
    ['DECLARATION', /^DECLARATION\b/],
    ['RESPONSE', /^(?:(?:PLAINTIFF|DEFENDANT|RESPONDENT|PETITIONER)(?:'S|S')?\s+)?(?:RESPONSE|REPLY|OPPOSITION)\b/],
    ['EXHIBIT', /^(?:EXHIBIT|ATTACHMENT)\b/],
    ['TRANSCRIPT', /^(?:(?:CERTIFIED|OFFICIAL)\s+)?TRANSCRIPT\b/],
    ['CORRESPONDENCE', /^(?:CORRESPONDENCE|LETTER)\b/],
    ['NOTICE', /^NOTICE\b/],
  ];
  const lines = text.slice(0, 6000).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.length > 160 || /[.!?]\s+\S/.test(line) || /[,;]$/.test(line)) continue;
    // Wrapped caption/prose lines such as "complaint herein," are not headings.
    // Accept uppercase or title-case words, allowing ordinary title connectors.
    if (!line.split(/\s+/).every(word => !/[A-Za-z]/.test(word) ||
      /^[^A-Za-z]*[A-Z]/.test(word) || /^(?:a|an|and|as|at|by|for|from|in|of|on|or|the|to|under|with)$/i.test(word))) continue;
    for (const [label, pattern] of rules) {
      if (pattern.test(line.toUpperCase())) return { label, family: DOCUMENT_FAMILIES[label] ?? label, evidence: line, confidence: 0.9 };
    }
  }
  // Source filenames commonly prefix the title with a portal and case identifier.
  // Underscore-separated metadata is weaker evidence than a recognized heading.
  const hints = path.basename(filename).replace(/\.pdf$/i, '').split('_').map(part => part.replace(/-/g, ' ').toUpperCase());
  for (const hint of hints) {
    for (const [label, pattern] of rules) {
      if (pattern.test(hint)) return { label, family: DOCUMENT_FAMILIES[label] ?? label, evidence: filename, confidence: 0.5 };
    }
  }
  return { label: 'OTHER', family: 'OTHER', evidence: '', confidence: 0 };
}

/**
 * Extract named entities (Statutes, Rules, Organizations, Locations/Parcels, Dates, Money).
 */
export function extractNamedEntities(fullText) {
  // 1. Minnesota Statutes & Court Rules
  const statuteRegex = /(?:Minn\.?\s*Stat\.?\s*(?:Ann\.?)?\s*§*\s*[\d\.]+(?:\s*\([a-z0-9]+\))*|\b\d+\s+U\.?S\.?C\.?\s*§*\s*[\d\w]+)/gi;
  const ruleRegex = /(?:Minn\.?\s*R\.?\s*(?:Civ\.?\s*P\.?|Gen\.?\s*Prac\.?|Evid\.?)\s*[\d\.]+)/gi;

  const statutesAndRules = [];
  for (const m of fullText.matchAll(statuteRegex)) {
    const val = m[0].replace(/\s+/g, ' ').trim();
    if (!statutesAndRules.includes(val)) statutesAndRules.push(val);
  }
  for (const m of fullText.matchAll(ruleRegex)) {
    const val = m[0].replace(/\s+/g, ' ').trim();
    if (!statutesAndRules.includes(val)) statutesAndRules.push(val);
  }

  // 2. Organizations & Trusts
  const orgRegex = /\b([A-Z][A-Za-z0-9\s,&]{2,50}\s+(?:LLC|LLP|Inc\.?|Corp\.?|Corporation|Trust|Company|Bank|Associates|Properties|Holdings|Rentals|Law Office|P\.A\.?))\b/g;
  const organizations = [];
  for (const m of fullText.matchAll(orgRegex)) {
    const org = m[1].replace(/\s+/g, ' ').trim();
    if (org.length > 3 && !organizations.includes(org) && !org.startsWith('State of')) {
      organizations.push(org);
    }
  }

  // 3. Real Estate Locations & Parcel Descriptions
  const parcelRegex = /(?:Parcel\s*(?:ID|No\.?|Number)?\s*[:#]?\s*[\d\-]+|Section\s+\d+,\s*Township\s+\d+,\s*Range\s+\d+|Plat\s+of\s+[A-Za-z0-9\s]+|Government\s+Lot\s+\d+)/gi;
  const locationsAndParcels = [];
  for (const m of fullText.matchAll(parcelRegex)) {
    const p = m[0].replace(/\s+/g, ' ').trim();
    if (!locationsAndParcels.includes(p)) locationsAndParcels.push(p);
  }

  // 4. Critical Dates
  const dateRegex = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/gi;
  const criticalDates = [];
  for (const m of fullText.matchAll(dateRegex)) {
    const d = m[0].trim();
    if (!criticalDates.includes(d)) criticalDates.push(d);
  }

  // 5. Monetary Amounts
  const moneyRegex = /\$\s*[\d,]+(?:\.\d{2})?\b/g;
  const monetaryAmounts = [];
  for (const m of fullText.matchAll(moneyRegex)) {
    const amt = m[0].replace(/\s+/g, '').trim();
    if (!monetaryAmounts.includes(amt) && amt !== '$0' && amt !== '$0.00') {
      monetaryAmounts.push(amt);
    }
  }

  return {
    statutesAndRules: statutesAndRules.slice(0, 30),
    organizations: organizations.slice(0, 25),
    locationsAndParcels: locationsAndParcels.slice(0, 20),
    criticalDates: criticalDates.slice(0, 25),
    monetaryAmounts: monetaryAmounts.slice(0, 15),
  };
}

/**
 * Parse structured document anatomy (Caption, Claims, Prayer for Relief, Signatures).
 */
export function extractDocumentAnatomy(fullText) {
  const anatomy = {
    caption: {},
    causesOfAction: [],
    prayerForRelief: [],
    signatures: [],
    exhibitsReferenced: [],
  };

  // Caption extraction
  const caseNoMatch = fullText.match(/(\d{1,2}[A-Z]{0,2}-[A-Z]{2,4}(?:-[A-Z]{2,4})?-\d{2,4}-\d+)/i);
  anatomy.caption.caseNumber = caseNoMatch ? caseNoMatch[1].toUpperCase() : '';

  const countyMatch = fullText.match(/COUNTY OF[ \t]+([A-Z][A-Z ]{1,40})(?=\r?\n|$)/i);
  anatomy.caption.county = countyMatch ? countyMatch[1].trim() : '';

  const distMatch = fullText.match(/([A-Z0-9]+)\s+JUDICIAL DISTRICT/i);
  anatomy.caption.judicialDistrict = distMatch ? distMatch[1].trim() : '';

  // Causes of Action / Counts
  const countRegex = /^(?:COUNT\s+([IVXLCDM]+|\d+)|((?:FIRST|SECOND|THIRD|FOURTH|FIFTH)\s+CAUSE\s+OF\s+ACTION))\s*[:\-]?\s*([^\n\r]*)/gim;
  let countMatch;
  while ((countMatch = countRegex.exec(fullText)) !== null) {
    const countNumber = countMatch[1] ? `COUNT ${countMatch[1]}` : countMatch[2].toUpperCase();
    const title = (countMatch[3] || 'Cause of Action').trim();
    const snippetStart = countMatch.index + countMatch[0].length;
    const snippet = fullText.slice(snippetStart, snippetStart + 500).replace(/\s+/g, ' ').trim();
    anatomy.causesOfAction.push({
      countNumber,
      title,
      allegationSnippet: snippet,
    });
  }

  // Prayer for Relief
  const prayerMatch = fullText.match(/WHEREFORE,?\s+(?:Plaintiff|Defendant|Petitioner)[^]+?(?=\bDated:|\bRespectfully submitted|\bBy:|\Z)/i);
  if (prayerMatch) {
    const prayerLines = prayerMatch[0]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.match(/^(?:\d+\.|\([a-z]\)|That\b|For\b)/i));
    anatomy.prayerForRelief = prayerLines.slice(0, 10);
  }

  // Signatures & Bar Numbers
  const sigBlockRegex = /(?:By:\s*\/s\/|By:\s*)([^\n]+)\n+([^\n]+)?\n*(?:Atty|Bar|Reg|License)?\s*(?:No\.?|#)?\s*[:#]?\s*(\d{6,7})/gi;
  let sigMatch;
  while ((sigMatch = sigBlockRegex.exec(fullText)) !== null) {
    anatomy.signatures.push({
      signer: sigMatch[1].trim(),
      firm: sigMatch[2] ? sigMatch[2].trim() : '',
      barNumber: sigMatch[3].trim(),
    });
  }

  // Exhibits Referenced
  const exhibitRegex = /\b(Exhibit\s+[A-Z0-9]+)\b(?:\s*[-–:]\s*([^\n\r,\.;]+))?/gi;
  const seenExhibits = new Set();
  let exMatch;
  while ((exMatch = exhibitRegex.exec(fullText)) !== null) {
    const tag = exMatch[1].trim();
    if (!seenExhibits.has(tag)) {
      seenExhibits.add(tag);
      anatomy.exhibitsReferenced.push({
        tag,
        description: exMatch[2] ? exMatch[2].trim() : '',
      });
    }
  }

  return anatomy;
}

/**
 * Generate structural chunks with contextual breadcrumb headers for LLM & Vector DBs.
 */
export function generateContextualChunks(fullText, meta = {}, maxChunkSize = 2500, overlap = 200) {
  if (!Number.isInteger(maxChunkSize) || maxChunkSize < 256) {
    throw new Error('maxChunkSize must be an integer of at least 256 characters');
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= maxChunkSize) {
    throw new Error('overlap must be a non-negative integer smaller than maxChunkSize');
  }

  const paragraphs = fullText.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const units = [];
  for (const paragraph of paragraphs) {
    let remaining = paragraph;
    while (remaining.length > maxChunkSize) {
      const candidate = remaining.slice(0, maxChunkSize + 1);
      const whitespace = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
      const splitAt = whitespace >= Math.floor(maxChunkSize * 0.6) ? whitespace : maxChunkSize;
      units.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining) units.push(remaining);
  }

  const chunks = [];
  const documentIdentity = meta.documentId ||
    crypto.createHash('sha256').update(meta.filename || 'document').digest('hex').slice(0, 16);
  const caseIdentity = meta.caseNumber || 'case';
  const headerPrefix = `[DOCUMENT: ${meta.documentType || 'LEGAL_FILING'} | CASE: ${meta.caseNumber || 'UNKNOWN'} | FILED: ${meta.filedDate || 'N/A'}]`;
  let currentChunk = '';

  const pushChunk = () => {
    if (!currentChunk) return;
    const index = chunks.length + 1;
    chunks.push({
      chunkId: `${caseIdentity}-${documentIdentity}-chunk-${index}`,
      index,
      text: `${headerPrefix}\n\n${currentChunk}`,
      charCount: currentChunk.length,
      tokenEstimate: Math.ceil(currentChunk.length / 4),
      metadata: {
        caseNumber: meta.caseNumber,
        documentId: documentIdentity,
        filename: meta.filename,
        documentType: meta.documentType,
        filedDate: meta.filedDate,
      },
    });
  };

  for (const unit of units) {
    const separatorLength = currentChunk ? 2 : 0;
    if (currentChunk && currentChunk.length + separatorLength + unit.length > maxChunkSize) {
      const previous = currentChunk;
      pushChunk();
      const overlapText = overlap > 0 ? previous.slice(-overlap).trimStart() : '';
      const allowedOverlap = Math.max(0, maxChunkSize - unit.length - (overlapText ? 2 : 0));
      currentChunk = allowedOverlap > 0 ? overlapText.slice(-allowedOverlap) : '';
    }
    currentChunk += `${currentChunk ? '\n\n' : ''}${unit}`;
  }
  pushChunk();
  return chunks;
}

/**
 * Process a single filing text file into a comprehensive FilingDossier.
 */
export function processFilingToDossier(fullText, filingMeta = {}) {
  const dossier = createFilingDossierTemplate(filingMeta);

  // 1. Classification
  dossier.filingMeta.documentType = classifyDocumentType(fullText, filingMeta.filename);

  // 2. Anatomy
  dossier.documentAnatomy = extractDocumentAnatomy(fullText);

  // 3. Named Entities
  dossier.nerAnalysis = extractNamedEntities(fullText);

  // 4. LLM Preprocessing & Chunks
  dossier.llmContext.chunks = generateContextualChunks(fullText, {
    caseNumber: dossier.filingMeta.caseNumber,
    documentId: dossier.filingMeta.documentId,
    filename: dossier.filingMeta.filename,
    documentType: dossier.filingMeta.documentType,
    filedDate: dossier.filingMeta.filedDate,
  });

  // Deterministic extractive preview. This is not represented as an LLM-generated conclusion.
  const firstText = fullText.slice(0, 800).replace(/\s+/g, ' ').trim();
  dossier.llmContext.executiveSummary =
    `[${dossier.filingMeta.documentType}] Extracted text preview: ${firstText.slice(0, 300)}${firstText.length > 300 ? '…' : ''}`;

  return dossier;
}

/**
 * Synthesize a comprehensive CaseDossier from all processed filing dossiers in a case directory.
 */
export function synthesizeCaseDossier(caseDir) {
  const indexPath = path.join(caseDir, 'docket-export-index.json');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Case manifest not found: ${indexPath}`);
  }

  let indexData;
  try {
    indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Case manifest is invalid: ${indexPath}: ${error.message}`);
  }

  const dossier = createCaseDossierTemplate({
    caseNumber: indexData.caseNumber,
    caseTitle: indexData.caseTitle,
    caseType: indexData.caseType,
    caseStatus: indexData.caseStatus,
    dateFiled: indexData.dateFiled,
    caseLocation: indexData.caseLocation,
    judicialOfficer: indexData.judicialOfficer,
  });
  dossier.roster.parties = Array.isArray(indexData.parties) ? indexData.parties : [];

  const manifestDocuments = Array.isArray(indexData.documents)
    ? indexData.documents : (Array.isArray(indexData.downloaded) ? indexData.downloaded : []);
  const jsonDossiers = new Set(manifestDocuments
    .filter(document => document.filename && document.status !== 'removed' && document.status !== 'failed')
    .map(document => document.filename)
    .filter(filename => path.basename(filename) === filename && /\.pdf$/i.test(filename))
    .map(filename => filename.replace(/\.pdf$/i, '.dossier.json')));

  for (const filename of jsonDossiers) {
    if (!fs.existsSync(path.join(caseDir, filename))) continue;
    const dossierPath = path.join(caseDir, filename);
    let filing;
    try {
      filing = JSON.parse(fs.readFileSync(dossierPath, 'utf-8'));
    } catch (error) {
      throw new Error(`Filing dossier is invalid: ${dossierPath}: ${error.message}`);
    }

    dossier.filings.push({
      documentId: filing.filingMeta.documentId,
      filename: filing.filingMeta.filename,
      documentType: filing.filingMeta.documentType,
      filedDate: filing.filingMeta.filedDate,
      summary: filing.llmContext.executiveSummary,
      causesOfAction: filing.documentAnatomy.causesOfAction,
    });

    for (const cause of filing.documentAnatomy.causesOfAction || []) {
      if (!dossier.semanticBrief.primaryCausesOfAction.includes(cause.title)) {
        dossier.semanticBrief.primaryCausesOfAction.push(cause.title);
      }
    }

    for (const parcel of filing.nerAnalysis.locationsAndParcels || []) {
      if (!dossier.semanticBrief.propertiesOrTransactionsInvolved.includes(parcel)) {
        dossier.semanticBrief.propertiesOrTransactionsInvolved.push(parcel);
      }
    }
  }

  const timelineDocuments = Array.isArray(indexData.documents)
    ? indexData.documents
    : (Array.isArray(indexData.downloaded) ? indexData.downloaded : []);
  dossier.proceduralTimeline = timelineDocuments.map((document) => ({
    documentKey: document.documentKey,
    index: document.index,
    date: document.date,
    description: document.description,
    filename: document.filename,
    sha256: document.sha256,
    sizeBytes: document.sizeBytes,
  }));

  dossier.semanticBrief.summary = `Extractive case index for ${dossier.caseMeta.caseTitle} (${dossier.caseMeta.caseNumber}), a ${dossier.caseMeta.caseType} matter filed on ${dossier.caseMeta.dateFiled}. Parsed cause headings: ${dossier.semanticBrief.primaryCausesOfAction.join(', ') || 'none detected'}.`;

  const outputPath = path.join(caseDir, 'case_dossier.json');
  writeJsonAtomic(outputPath, dossier);
  console.log(`[NLP Dossier] Synthesized case dossier -> ${outputPath}`);
  return dossier;
}
