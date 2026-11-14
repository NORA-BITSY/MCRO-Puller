import path from 'node:path';
import os from 'node:os';
function envInteger(name, fallback, minimum = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}; received \"${raw}\"`);
  }
  return value;
}


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
  
  // Cooperative request pacing
  delays: {
    minDelayMs: envInteger('MCRO_MIN_DELAY_MS', 8000, 0),
    maxDelayMs: envInteger('MCRO_MAX_DELAY_MS', 20000, 0),
    pageLoadTimeoutMs: envInteger('MCRO_PAGE_TIMEOUT_MS', 30000, 1000),
    searchTimeoutMs: envInteger('MCRO_SEARCH_TIMEOUT_MS', 45000, 1000),
    downloadTimeoutMs: envInteger('MCRO_DOWNLOAD_TIMEOUT_MS', 30000, 1000),
  },
  
  // PDF Verification rules
  pdf: {
    minBytes: 1024,
    magicBytes: [0x25, 0x50, 0x44, 0x46], // %PDF
  },
  
  // Max retries per document
  maxRetries: envInteger('MCRO_MAX_RETRIES', 3, 1),

  // Operator-approved concurrent live pull jobs. Hard ceiling 10 to start;
  // cooperative jitter pacing still applies between requests per worker.
  concurrency: envInteger('MCRO_CONCURRENCY', 10, 1),

  // Live pull proxy pool. Comma-separated proxy URLs (one per concurrent
  // worker, assigned stickily by worker index); COURT_PROXY is a single-proxy
  // shorthand. Empty means direct connections.
  proxyPool: (process.env.COURT_PROXIES || process.env.COURT_PROXY || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
};

export const MAX_PULL_CONCURRENCY = 10;
