/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import packageJson from 'package-json';
import semver from 'semver';
import { getPackageJson } from '../../utils/package.js';
import { createDebugLogger } from '@nestor/nessy-cli-core';
import { NPM_REGISTRY_URL } from '../../constants.js';

const debugLogger = createDebugLogger('UPDATE_CHECK');

export interface UpdateInfo {
  latest: string;
  current: string;
  type: string;
  name: string;
}

export interface UpdateObject {
  message: string;
  update: UpdateInfo;
}

async function fetchLatestVersion(
  name: string,
  distTag: 'latest' | 'nightly',
): Promise<UpdateInfo | null> {
  try {
    const result = await packageJson(name, {
      version: distTag,
      registryUrl: NPM_REGISTRY_URL,
    });
    return {
      latest: result.version,
      current: '',
      type: distTag,
      name,
    };
  } catch {
    return null;
  }
}

/**
 * From a nightly and stable update, determines which is the "best" one to offer.
 * The rule is to always prefer nightly if the base versions are the same.
 */
function getBestAvailableUpdate(
  nightly?: UpdateInfo | null,
  stable?: UpdateInfo | null,
): UpdateInfo | null {
  if (!nightly) return stable || null;
  if (!stable) return nightly || null;

  const nightlyVer = nightly.latest;
  const stableVer = stable.latest;

  if (
    semver.coerce(stableVer)?.version === semver.coerce(nightlyVer)?.version
  ) {
    return nightly;
  }

  return semver.gt(stableVer, nightlyVer) ? stable : nightly;
}

export async function checkForUpdates(): Promise<UpdateObject | null> {
  try {
    // Skip update check when running from source (development mode)
    if (process.env['DEV'] === 'true' || process.env['NESSY_DEV'] === 'true') {
      return null;
    }
    const pkg = await getPackageJson();
    if (!pkg || !pkg.name || !pkg.version) {
      return null;
    }

    const { name, version: currentVersion } = pkg;
    const isNightly = currentVersion.includes('nightly');

    if (isNightly) {
      const [nightlyUpdateInfo, latestUpdateInfo] = await Promise.all([
        fetchLatestVersion(name, 'nightly'),
        fetchLatestVersion(name, 'latest'),
      ]);

      const bestUpdate = getBestAvailableUpdate(
        nightlyUpdateInfo,
        latestUpdateInfo,
      );

      if (bestUpdate && semver.gt(bestUpdate.latest, currentVersion)) {
        const message = `A new version of Nessy CLI is available! ${currentVersion} → ${bestUpdate.latest}`;
        return {
          message,
          update: { ...bestUpdate, current: currentVersion },
        };
      }
    } else {
      const updateInfo = await fetchLatestVersion(name, 'latest');

      if (updateInfo && semver.gt(updateInfo.latest, currentVersion)) {
        const message = `Nessy CLI update available! ${currentVersion} → ${updateInfo.latest}`;
        return {
          message,
          update: { ...updateInfo, current: currentVersion },
        };
      }
    }

    return null;
  } catch (e) {
    debugLogger.warn('Failed to check for updates: ' + e);
    return null;
  }
}
