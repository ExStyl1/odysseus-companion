#!/usr/bin/env node
import { resolve } from 'node:path';
import { ensureFirstRun } from './setup/first-run.mjs';
const root = resolve(import.meta.dirname, '..');
try {
  const result = ensureFirstRun(root, { check: process.argv.includes('--check') });
  console.log(
    JSON.stringify(
      {
        status: result.status,
        alreadyInstalled: Boolean(result.alreadyInstalled),
        profiles: result.profiles,
        sources: result.sources,
        installations: result.installations,
        files: result.files,
        bytes: result.bytes,
        skipped: (result.skipped || []).length,
        warnings: (result.warnings || []).length,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
