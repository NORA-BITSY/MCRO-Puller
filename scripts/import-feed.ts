import { Command, Option } from 'commander';
import { createDatabase, migrate } from '../src/platform/database.js';
import { importFeed } from '../src/platform/imports.js';

const command = new Command('import-feed')
  .description('Import an already-obtained local Minnesota metadata extract; never fetch a subscription feed')
  .argument('<file>', 'Local UTF-8 CSV, pipe-delimited, or JSONL file')
  .addOption(new Option('--format <format>', 'Input format').choices(['csv', 'pipe', 'jsonl']).makeOptionMandatory())
  .addOption(new Option('--source-id <source>', 'Source namespace').choices(['mn-mcro']).default('mn-mcro'))
  .option('--acquire-results', 'Explicitly enqueue docket refreshes (does not enable live source access)', false);

try {
  command.parse();
  const options = command.opts<{ format: 'csv' | 'pipe' | 'jsonl'; sourceId: string; acquireResults: boolean }>();
  const filename = command.args[0];
  if (!filename) throw new Error('A local input file is required');
  const databaseUrl = process.env.COURT_DATABASE_URL;
  if (!databaseUrl) throw new Error('COURT_DATABASE_URL is required');
  const pool = createDatabase(databaseUrl);
  try {
    await migrate(pool);
    const report = await importFeed(pool, filename, options);
    console.log(JSON.stringify(report, null, 2));
    if (report.rejectedRows > 0) process.exitCode = 2;
  } finally { await pool.end(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
