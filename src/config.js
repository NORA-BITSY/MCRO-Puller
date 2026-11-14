import path from 'node:path';
import os from 'node:os';

export const CONFIG = {
  urls: {
    base: 'https://publicaccess.courts.state.mn.us/',
    caseSearch: 'https://publicaccess.courts.state.mn.us/CaseSearch',
    documentSearch: 'https://publicaccess.courts.state.mn.us/DocumentSearch',
    hearingSearch: 'https://publicaccess.courts.state.mn.us/HearingSearch',
    judgmentSearch: 'https://publicaccess.courts.state.mn.us/JudgmentSearch',
    viewCaseDetails: 'https://publicaccess.courts.state.mn.us/CaseSearch/ViewCaseDetails',
    downloadDocument: 'https://publicaccess.courts.state.mn.us/CaseSearch/DownloadDocument',
  },
  outputDir: process.env.MCRO_OUTPUT_DIR || path.join(os.homedir(), 'mncourt-data', 'cases'),
  stateFile: process.env.MCRO_STATE_FILE || path.join(os.homedir(), 'mncourt-data', 'state.json'),
  sessionFile: path.join(os.homedir(), '.mcro-puller', 'session.json'),
  
  // Rate limiting / WAF avoidance
  delays: {
    minDelayMs: parseInt(process.env.MCRO_MIN_DELAY_MS || '8000', 10),
    maxDelayMs: parseInt(process.env.MCRO_MAX_DELAY_MS || '20000', 10),
    pageLoadTimeoutMs: 30000,
    searchTimeoutMs: 45000,
    downloadTimeoutMs: 30000,
  },
  
  // PDF Verification rules
  pdf: {
    minBytes: 1024,
    magicBytes: [0x25, 0x50, 0x44, 0x46], // %PDF
  },
  
  // Max retries per document
  maxRetries: 3,
};
