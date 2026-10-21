/**
 * eslint-lint-proof-formatter — ESLint's own `stylish` output, plus the one
 * number `stylish` never prints: how many files were actually linted.
 *
 * P2.358. `npx eslint .` in a package whose flat config matches nothing prints
 * NOTHING and exits 0 — byte-identical to a package that linted 300 files
 * clean. That is how `packages/server-core` sat unlinted behind a
 * config-shaped hole, and P2.319's coverage check closed only the level above
 * it: it proves a config EXISTS and is INVOKED, not that the config selects a
 * single file. A `files: []` config passes that check and lints nothing.
 *
 * ESLint hands a formatter one `results` entry per LINTED file, so the count is
 * already in hand — it is only ever thrown away. This formatter keeps it:
 *
 *   - to stdout, for a human, after the unmodified `stylish` block;
 *   - to the file named by `NESSY_ESLINT_PROOF_FILE`, as JSON, for
 *     `scripts/lint-package.ts`, which turns a zero into a non-zero exit.
 *
 * Delegating to `stylish` rather than re-rendering is deliberate: the human
 * half of a lint run must not change shape because a gate was added under it.
 */

import { writeFileSync } from 'node:fs'
import { ESLint } from 'eslint'

export default async function nessyLintProofFormatter(results, context) {
  const stylish = await new ESLint().loadFormatter('stylish')
  const body = await stylish.format(results, context)

  const proof = {
    files: results.length,
    errors: results.reduce((n, r) => n + r.errorCount, 0),
    warnings: results.reduce((n, r) => n + r.warningCount, 0),
  }

  const proofFile = process.env.NESSY_ESLINT_PROOF_FILE
  if (proofFile !== undefined && proofFile !== '') {
    writeFileSync(proofFile, JSON.stringify(proof), 'utf-8')
  }

  const summary =
    `eslint proof: ${proof.files} files linted, ` +
    `${proof.errors} errors, ${proof.warnings} warnings`

  return `${body}${body.endsWith('\n') || body === '' ? '' : '\n'}${summary}\n`
}
