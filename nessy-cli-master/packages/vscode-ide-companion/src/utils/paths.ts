/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as dotenv from 'dotenv';

/**
 * Expands tilde and resolves relative paths to absolute.
 * Mirrors Storage.resolvePath() in packages/core.
 */
function resolvePath(dir: string): string {
  let resolved = dir;
  if (
    resolved === '~' ||
    resolved.startsWith('~/') ||
    resolved.startsWith('~\\')
  ) {
    const relativeSegments =
      resolved === '~'
        ? []
        : resolved
            .slice(2)
            .split(/[/\\]+/)
            .filter(Boolean);
    resolved = path.join(os.homedir(), ...relativeSegments);
  }
  if (!path.isAbsolute(resolved)) {
    resolved = path.resolve(resolved);
  }
  return resolved;
}

let envBootstrapped = false;

/**
 * Pre-resolves NESSY_HOME / NESSY_RUNTIME_DIR from `<homedir>/.nessy/.env` and
 * `<homedir>/.env`. Mirrors the CLI's `preResolveHomeEnvOverrides` so the
 * companion's lock-file location agrees with the CLI even when these vars
 * are only configured via `.env`. Idempotent.
 */
function bootstrapHomeEnvOverrides(): void {
  if (envBootstrapped) {
    return;
  }
  envBootstrapped = true;

  if (process.env['NESSY_HOME'] && process.env['NESSY_RUNTIME_DIR']) {
    return;
  }

  const homeDir = os.homedir();
  if (!homeDir) {
    return;
  }

  const initialNessyHome = process.env['NESSY_HOME'];
  const currentNessyDir = initialNessyHome
    ? resolvePath(initialNessyHome)
    : path.join(homeDir, '.nessy');

  const KEYS = ['NESSY_HOME', 'NESSY_RUNTIME_DIR'] as const;
  const readInto = (file: string) => {
    try {
      const parsed = dotenv.parse(fs.readFileSync(file, 'utf-8'));
      for (const key of KEYS) {
        if (parsed[key] && !Object.hasOwn(process.env, key)) {
          process.env[key] = parsed[key];
        }
      }
    } catch {
      // Match the dotenv quiet-mode behavior used by the CLI.
    }
  };

  readInto(path.join(currentNessyDir, '.env'));
  if (!initialNessyHome) {
    readInto(path.join(homeDir, '.env'));
  }

  // If NESSY_HOME was just discovered, also read <new NESSY_HOME>/.env so
  // NESSY_RUNTIME_DIR can be sourced from there — otherwise the companion
  // would write lock files into a different runtime dir than the CLI reads.
  const discoveredNessyHome = process.env['NESSY_HOME'];
  if (discoveredNessyHome && discoveredNessyHome !== initialNessyHome) {
    const discoveredDir = resolvePath(discoveredNessyHome);
    if (discoveredDir !== currentNessyDir) {
      readInto(path.join(discoveredDir, '.env'));
    }
  }
}

/** Test-only: reset the bootstrap latch. */
export function resetEnvBootstrapForTesting(): void {
  envBootstrapped = false;
}

/**
 * Returns the global Nessy home directory (config, credentials, etc.).
 *
 * Priority: NESSY_HOME env var > ~/.nessy
 */
export function getGlobalNessyDir(): string {
  bootstrapHomeEnvOverrides();
  const envDir = process.env['NESSY_HOME'];
  if (envDir) {
    return resolvePath(envDir);
  }
  const homeDir = os.homedir();
  return homeDir
    ? path.join(homeDir, '.nessy')
    : path.join(os.tmpdir(), '.nessy');
}

/**
 * Returns the runtime base directory for ephemeral data (tmp, debug, IDE
 * lock files, sessions, etc.).
 *
 * Priority: NESSY_RUNTIME_DIR env var > NESSY_HOME env var > ~/.nessy
 *
 * This mirrors the fallback chain in packages/core Storage.getRuntimeBaseDir()
 * without importing from core to avoid cross-package dependencies.
 */
export function getRuntimeBaseDir(): string {
  bootstrapHomeEnvOverrides();
  const runtimeDir = process.env['NESSY_RUNTIME_DIR'];
  if (runtimeDir) {
    return resolvePath(runtimeDir);
  }
  return getGlobalNessyDir();
}
