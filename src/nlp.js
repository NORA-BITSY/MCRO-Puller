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
  const upper = (text.slice(0, 4000) + ' ' + filename).toUpperCase();

  if (upper.includes('AFFIDAVIT OF SERVICE') || upper.includes('CERTIFICATE OF SERVICE')) return 'AFFIDAVIT_OF_SERVICE';
  if (upper.includes('CIVIL COVER SHEET')) return 'CIVIL_COVER_SHEET';
  if (upper.includes('NOTICE OF CASE FILING')) return 'NOTICE_OF_CASE_FILING';
  if (upper.includes('NOTICE OF DEFICIENCY')) return 'NOTICE_OF_DEFICIENCY';
  if (upper.includes('ANSWER')) return 'ANSWER';
  if (upper.includes('MOTION')) return 'MOTION';
  if (upper.includes('ORDER')) return 'ORDER';
  if (upper.includes('JUDGMENT')) return 'JUDGMENT';
  if (upper.includes('SUMMONS AND COMPLAINT')) return 'SUMMONS_AND_COMPLAINT';
  if (upper.includes('SUMMONS')) return 'SUMMONS';
  if (upper.includes('COMPLAINT') || upper.includes('PETITION')) return 'COMPLAINT';
  if (upper.includes('AFFIDAVIT')) return 'AFFIDAVIT';
  if (upper.includes('NOTICE')) return 'NOTICE';
  return 'OTHER';
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

  const files = fs.readdirSync(caseDir);
  const jsonDossiers = files.filter((f) => f.endsWith('.dossier.json'));

  for (const filename of jsonDossiers) {
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
