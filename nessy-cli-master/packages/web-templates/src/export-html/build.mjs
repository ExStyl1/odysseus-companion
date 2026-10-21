import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { buildConfig } from './esbuild.config.mjs';
import prettier from 'prettier';

const assetsDir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(assetsDir, 'src');
const assetsDistDir = join(assetsDir, 'dist');
const generatedDir = join(assetsDir, '..', 'generated');
await mkdir(generatedDir, { recursive: true });
await mkdir(assetsDistDir, { recursive: true });

const templateModulePath = join(generatedDir, 'exportHtmlTemplate.ts');

const buildResult = await build(buildConfig);

const jsBundle = buildResult.outputFiles.find((file) =>
  file.path.endsWith('.js'),
);
const cssBundle = buildResult.outputFiles.find((file) =>
  file.path.endsWith('.css'),
);
if (!jsBundle) {
  throw new Error('Failed to generate inline script bundle.');
}

const css = cssBundle
  ? cssBundle.text
  : await readFile(join(srcDir, 'styles.css'), 'utf8');
const htmlTemplate = await readFile(join(srcDir, 'index.html'), 'utf8');
const faviconSvg = await readFile(join(srcDir, 'favicon.svg'), 'utf8');
const faviconData = encodeURIComponent(faviconSvg.trim());

const htmlOutput = htmlTemplate
  .replace('__INLINE_CSS__', css.trim())
  .replace('__INLINE_SCRIPT__', jsBundle.text.trim())
  .replace('__FAVICON_SVG__', faviconSvg.trim())
  .replace('__FAVICON_DATA__', faviconData);

const templateModule = `/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * This HTML template is code-generated; do not edit manually.
 */

export const HTML_TEMPLATE = ${JSON.stringify(htmlOutput)};
`;

const formattedTemplateModule = await prettier.format(templateModule, {
  parser: 'typescript',
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  printWidth: 80,
  tabWidth: 2,
});

await writeFile(join(assetsDistDir, 'index.html'), htmlOutput);
await writeFile(templateModulePath, formattedTemplateModule);
