/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { globSync } from 'glob';

// A script to handle versioning and ensure all related changes are in a single, atomic commit.

function run(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: 'inherit' });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

// 1. Get the version from the command line arguments.
const versionType = process.argv[2];
if (!versionType) {
  console.error('Error: No version specified.');
  console.error(
    'Usage: npm run version <version> (e.g., 1.2.3 or patch|minor|major|prerelease)',
  );
  process.exit(1);
}

// 2. Bump the version in the root and all workspace package.json files.
run(`npm version ${versionType} --no-git-tag-version --allow-same-version`);

// 3. Get all workspaces from package.json and filter out the ones we don't want to version.
// We intend to maintain sdk version independently.
// Note: we parse package.json directly instead of using `npm ls --workspaces` because
// `npm ls --workspaces` can incorrectly report transitive dependencies (e.g. @esbuild/linux-x64)
// as workspaces when package-lock.json has been modified by `npm i --no-save`.
const rootPackageJsonPath = resolve(process.cwd(), 'package.json');
const rootPackageJson = readJson(rootPackageJsonPath);
const workspacesToExclude = ['@nestor/nessy-cli-sdk'];
const allWorkspaces = resolveWorkspaces(rootPackageJson);
const workspacesToVersion = allWorkspaces.filter(
  (wsName) => !workspacesToExclude.includes(wsName),
);

for (const workspaceName of workspacesToVersion) {
  run(
    `npm version ${versionType} --workspace ${workspaceName} --no-git-tag-version --allow-same-version`,
  );
}

/**
 * Resolve workspace package names from the root package.json `workspaces` field.
 * Handles glob patterns (e.g., "packages/*") and exclusion patterns (e.g., "!packages/desktop").
 * Only returns workspaces that actually exist on disk and have a package.json.
 */
function resolveWorkspaces(pkg) {
  const globs = pkg.workspaces || [];
  const included = globs.filter((g) => !g.startsWith('!'));
  const excluded = new Set(
    globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1)),
  );

  const results = [];
  for (const pattern of included) {
    const matches = globSync(pattern, {
      cwd: process.cwd(),
      onlyDirectories: true,
    });
    for (const match of matches) {
      if (excluded.has(match)) continue;
      const pkgPath = resolve(process.cwd(), match, 'package.json');
      try {
        const wsPkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (wsPkg.name) {
          results.push(wsPkg.name);
        }
      } catch {
        // directory without package.json — skip
      }
    }
  }
  return results;
}

// 4. Get the new version number from the root package.json
const newVersion = readJson(rootPackageJsonPath).version;

// 5. Update the sandboxImageUri in the root package.json
if (rootPackageJson.config?.sandboxImageUri) {
  rootPackageJson.config.sandboxImageUri =
    rootPackageJson.config.sandboxImageUri.replace(/:.*$/, `:${newVersion}`);
  console.log(`Updated sandboxImageUri in root to use version ${newVersion}`);
  writeJson(rootPackageJsonPath, rootPackageJson);
}

// 6. Update the sandboxImageUri in the cli package.json
const cliPackageJsonPath = resolve(process.cwd(), 'packages/cli/package.json');
const cliPackageJson = readJson(cliPackageJsonPath);
if (cliPackageJson.config?.sandboxImageUri) {
  cliPackageJson.config.sandboxImageUri =
    cliPackageJson.config.sandboxImageUri.replace(/:.*$/, `:${newVersion}`);
  console.log(
    `Updated sandboxImageUri in cli package to use version ${newVersion}`,
  );
  writeJson(cliPackageJsonPath, cliPackageJson);
}

// 7. Update pluginVersion in intellij-ide-companion gradle.properties.
const gradlePropertiesPath = resolve(
  process.cwd(),
  'packages/intellij-ide-companion/gradle.properties',
);
const gradleProperties = readFileSync(gradlePropertiesPath, 'utf-8');
const updatedGradleProperties = gradleProperties.replace(
  /^pluginVersion=.*/m,
  `pluginVersion=${newVersion}`,
);
writeFileSync(gradlePropertiesPath, updatedGradleProperties);
console.log(`Updated pluginVersion in gradle.properties to ${newVersion}`);

// 8. Update desktop version (packages/desktop/package.json, apps/electron/package.json, packages/shared/package.json).
try {
  execSync(
    `cd packages/desktop && bun run bump-desktop-version ${newVersion}`,
    { stdio: 'inherit' },
  );
  console.log(`Updated desktop version to ${newVersion}`);
} catch (_error) {
  console.warn(
    'Warning: Failed to update desktop version. Skipping desktop bump.',
  );
}

// 9. Run `npm install` to update package-lock.json.
// --ignore-scripts prevents the root `prepare` lifecycle from triggering a
// redundant full build that fails with TS5055 when dist/ already exists from
// the initial `npm ci` install.
run(
  'npm install --workspace packages/cli --workspace packages/core --workspace packages/channels/base --workspace packages/channels/plugin-example --package-lock-only --ignore-scripts',
);

console.log(`Successfully bumped versions to v${newVersion}.`);
