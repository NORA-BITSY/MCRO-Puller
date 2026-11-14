/**
 * Comprehensive Case and Filing Data Model Definitions.
 */

export function createCaseDossierTemplate(caseInfo = {}) {
  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    caseMeta: {
      caseNumber: caseInfo.caseNumber || '',
      caseTitle: caseInfo.caseTitle || '',
      caseType: caseInfo.caseType || '',
      category: caseInfo.category || '',
      caseStatus: caseInfo.caseStatus || 'Open',
      dateFiled: caseInfo.dateFiled || '',
      caseLocation: caseInfo.caseLocation || '',
      county: caseInfo.county || '',
      judicialDistrict: caseInfo.judicialDistrict || '',
      judicialOfficer: caseInfo.judicialOfficer || '',
    },
    roster: {
      parties: [],
      attorneys: [],
    },
    proceduralTimeline: [],
    filings: [],
    crossDocumentGraph: {
      edges: [], // e.g. [{ sourceDoc: 'Summons', targetDoc: 'Affidavit of Service', relation: 'served_by' }]
    },
    financialSummary: {
      finesAndFees: null,
      judgments: [],
    },
    semanticBrief: {
      summary: '',
      primaryCausesOfAction: [],
      propertiesOrTransactionsInvolved: [],
      proceduralPosture: '',
    },
  };
}

export function createFilingDossierTemplate(filingMeta = {}) {
  return {
    schemaVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    filingMeta: {
      documentId: filingMeta.documentId || '',
      caseNumber: filingMeta.caseNumber || '',
      filename: filingMeta.filename || '',
      sha256: filingMeta.sha256 || '',
      sizeBytes: filingMeta.sizeBytes || 0,
      totalPages: filingMeta.totalPages || 0,
      filedDate: filingMeta.filedDate || '',
      sourceIndex: filingMeta.sourceIndex || null,
      documentType: filingMeta.documentType || 'OTHER',
    },
    documentAnatomy: {
      caption: {
        court: '',
        county: '',
        judicialDistrict: '',
        caseNumber: '',
        caseType: '',
        plaintiffs: [],
        defendants: [],
      },
      preamble: '',
      jurisdictionAndVenue: [],
      partiesIdentification: [],
      factualAllegations: [],
      causesOfAction: [],
      prayerForRelief: [],
      signatures: [],
      exhibitsReferenced: [],
    },
    nerAnalysis: {
      persons: [],
      organizations: [],
      locationsAndParcels: [],
      statutesAndRules: [],
      criticalDates: [],
      monetaryAmounts: [],
    },
    llmContext: {
      executiveSummary: '',
      keyClaimsSummary: [],
      chunks: [],
    },
  };
}
