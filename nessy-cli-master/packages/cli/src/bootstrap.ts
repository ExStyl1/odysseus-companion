/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

let extraCaCertTrusted = false;
// [nessy-fork] statist-trusted-ca
const CA_FILE_NAMES = ['tinkoff-bundle.crt', 'russian-root-ca.crt'];

// [nessy-fork] desktop-first-run-setup
export function resolveBundledCaPaths(moduleDir: string): string[] {
  const directories = [
    join(moduleDir, 'certs'),
    join(moduleDir, '..', '..', '..', 'certs'),
    join(moduleDir, '..', '..', '..', '..', 'certs'),
  ];

  for (const directory of directories) {
    const paths = CA_FILE_NAMES.map((fileName) =>
      join(directory, fileName),
    ).filter((candidate) => existsSync(candidate));
    if (paths.length > 0) return paths;
  }

  return [];
}

export function resolveBundledCaPath(moduleDir: string): string | undefined {
  return resolveBundledCaPaths(moduleDir)[0];
}

/**
 * Configure bundled CA certificate.
 * User can disable via useBundledCa: false in settings.json security.ca section.
 */
export function ensureExtraCaCert(
  moduleDir = dirname(fileURLToPath(import.meta.url)),
  homeDir = os.homedir() || os.tmpdir(),
  workspaceDir = process.cwd(),
) {
  try {
    if (process.env['NESSY_USE_BUNDLED_CA'] === 'false') {
      return;
    }

    const settingsValue = readUseBundledCaSetting(homeDir, workspaceDir);
    if (settingsValue === false) {
      process.env['NESSY_USE_BUNDLED_CA'] = 'false';
      return;
    }

    const globalNessyDir = join(homeDir, '.nessy');
    const targetCertDir = join(globalNessyDir, 'certs');
    const targetCertPaths = CA_FILE_NAMES.map((fileName) =>
      join(targetCertDir, fileName),
    );
    // [nessy-fork] desktop-first-run-setup
    const bundledCertPaths = resolveBundledCaPaths(moduleDir);

    if (bundledCertPaths.length > 0) {
      try {
        mkdirSync(targetCertDir, { recursive: true });
        for (const bundledCertPath of bundledCertPaths) {
          const fileName = CA_FILE_NAMES.find((name) =>
            bundledCertPath.endsWith(name),
          );
          if (fileName) {
            copyFileSync(bundledCertPath, join(targetCertDir, fileName));
          }
        }
      } catch {
        // The shipped certificates remain usable when the cache is not writable.
      }
    }

    // [nessy-fork] desktop-first-run-setup
    const certPaths =
      bundledCertPaths.length > 0
        ? bundledCertPaths
        : targetCertPaths.filter((certPath) => existsSync(certPath));
    if (certPaths.length > 0) {
      process.env['NODE_EXTRA_CA_CERTS'] ??= certPaths[0];
      // [nessy-fork] macos-internal-seatbelt-profile
      trustExtraCaCertInCurrentProcess(certPaths);
    }
  } catch {
    // Avoid blocking startup if cert setup fails.
  }
}

// [nessy-fork] macos-internal-seatbelt-profile
export function trustExtraCaCertInCurrentProcess(
  certPaths: string | string[],
): void {
  if (extraCaCertTrusted) {
    return;
  }

  const certs = (Array.isArray(certPaths) ? certPaths : [certPaths]).flatMap(
    (certPath) =>
      readFileSync(certPath, 'utf-8').match(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
      ) ?? [],
  );
  if (certs.length === 0) {
    return;
  }

  const createSecureContext = tls.createSecureContext;
  tls.createSecureContext = (options = {}) => {
    const context = createSecureContext(options);
    if (options.ca === undefined) {
      const handle = (
        context as unknown as {
          context?: { addCACert?: (cert: string) => void };
        }
      ).context;
      for (const cert of certs) {
        handle?.addCACert?.(cert);
      }
    }
    return context;
  };
  extraCaCertTrusted = true;
}

function readUseBundledCaSetting(
  homeDir: string,
  workspaceDir: string,
): boolean | undefined {
  const userSettingsPath = join(homeDir, '.nessy', 'settings.json');
  const workspaceSettingsPath = join(workspaceDir, '.nessy', 'settings.json');

  return (
    readSettingFromFile(workspaceSettingsPath) ??
    readSettingFromFile(userSettingsPath)
  );
}

function readSettingFromFile(settingsPath: string): boolean | undefined {
  try {
    if (!existsSync(settingsPath)) {
      return undefined;
    }
    const raw = readFileSync(settingsPath, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const security = data['security'] as Record<string, unknown> | undefined;
    const ca = security?.['ca'] as Record<string, unknown> | undefined;
    const value = ca?.['useBundledCa'];
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

// [nessy-fork] custom-ca-certificates
ensureExtraCaCert();
