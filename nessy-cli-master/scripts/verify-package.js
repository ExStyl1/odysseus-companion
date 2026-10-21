/**
 * @license
 * Copyright 2025 Nessy
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const distPackagePath = path.join(distDir, 'package.json');

if (!fs.existsSync(distPackagePath)) {
  console.error('Error: dist/package.json not found.');
  console.error('Run "npm run prepare:package" before publishing.');
  process.exit(1);
}

const distPackageJson = JSON.parse(fs.readFileSync(distPackagePath, 'utf-8'));

const binField = distPackageJson.bin;
if (!binField) {
  console.error('Error: "bin" field missing in dist/package.json.');
  process.exit(1);
}

const binPath = typeof binField === 'string' ? binField : binField.nessy;

if (!binPath) {
  console.error('Error: "bin" field does not expose "nessy".');
  process.exit(1);
}

const resolvedBinPath = path.join(distDir, binPath);
if (!fs.existsSync(resolvedBinPath)) {
  console.error(
    `Error: bin target not found at ${path.relative(rootDir, resolvedBinPath)}`,
  );
  process.exit(1);
}

console.log('✅ dist package looks OK for publishing.');
