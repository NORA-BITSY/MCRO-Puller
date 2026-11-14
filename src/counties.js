import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COUNTIES_JSON_PATH = path.join(__dirname, 'counties.json');

export const COUNTIES = JSON.parse(fs.readFileSync(COUNTIES_JSON_PATH, 'utf-8'));

const nameMap = new Map();
const codeMap = new Map();

COUNTIES.forEach((c) => {
  nameMap.set(c.name.toLowerCase(), c);
  codeMap.set(c.code, c);
});

export function lookupCounty(query) {
  if (!query) return null;
  const qStr = String(query).trim().toLowerCase();
  if (nameMap.has(qStr)) return nameMap.get(qStr);
  if (codeMap.has(qStr)) return codeMap.get(qStr);

  // Partial match
  for (const [name, c] of nameMap.entries()) {
    if (name.includes(qStr) || qStr.includes(name)) {
      return c;
    }
  }
  return null;
}

export function getAllCountyNames() {
  return COUNTIES.map((c) => c.name);
}
