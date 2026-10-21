import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SUPPORTED_COMPONENTS = [
  'cli',
  'sdk-typescript',
  'sdk-python',
  'sdk-java',
]; // supported components

/**
 * Parses a release tag into component type and version.
 * @param {string} tag - e.g. "release-cli-1.2.3-beta.0" or "release-sdk-typescript-1.2.3"
 * @returns {{ componentType: string, tagVersion: string }}
 */
export function parseTag(tag) {
  const componentType = tag.replace(/^release-/, '').replace(/-[0-9].*/, '');
  const tagVersion = tag.replace(`release-${componentType}-`, '');
  return { componentType, tagVersion };
}

/**
 * Validates that package versions match the tag version.
 * @param {string} tag - release tag
 * @param {string} basePath - project root
 * @returns {{ ok: boolean, error?: string }}
 */
export function checkVersions(tag, basePath) {
  const { componentType, tagVersion } = parseTag(tag);

  if (!SUPPORTED_COMPONENTS.includes(componentType)) {
    return {
      ok: false,
      error: `Unsupported component type '${componentType}'`,
    };
  }

  let actualVersion;
  const isStable = !/-(alpha|beta|rc)/.test(tagVersion);

  // Extract version based on component type
  if (componentType === 'cli') {
    actualVersion = JSON.parse(
      readFileSync(resolve(basePath, 'package.json'), 'utf-8'),
    ).version;
  } else if (componentType === 'sdk-typescript') {
    actualVersion = JSON.parse(
      readFileSync(
        resolve(basePath, 'packages/sdk-typescript/package.json'),
        'utf-8',
      ),
    ).version;
  } else if (componentType === 'sdk-python') {
    const pyprojectContent = readFileSync(
      resolve(basePath, 'packages/sdk-python/pyproject.toml'),
      'utf-8',
    );
    const match = pyprojectContent.match(/^version = "([^"]+)"$/m);
    if (!match) {
      return {
        ok: false,
        error: `Could not find version in packages/sdk-python/pyproject.toml`,
      };
    }
    actualVersion = match[1];
    // For Python SDK, tag uses PEP 440 format (1.0.1rc0)
    // Stable tags: compare base version (strip -alpha, -beta, -rc suffixes)
    // Prerelease tags: exact comparison
    if (isStable) {
      const baseVersion = actualVersion.replace(/-(alpha|beta|rc)\.\d+$/, '');
      if (baseVersion === tagVersion) {
        return { ok: true };
      }
    } else {
      if (actualVersion === tagVersion) {
        return { ok: true };
      }
    }
    return {
      ok: false,
      error: `${componentType} version mismatch - expected '${tagVersion}', got '${actualVersion}'`,
    };
  } else if (componentType === 'sdk-java') {
    const pomContent = readFileSync(
      resolve(basePath, 'packages/sdk-java/nessycli/pom.xml'),
      'utf-8',
    );
    const match = pomContent.match(/<version>([^<]+)<\/version>/);
    if (!match) {
      return {
        ok: false,
        error: `Could not find version in packages/sdk-java/nessycli/pom.xml`,
      };
    }
    actualVersion = match[1];
    // pom.xml in master always carries X.Y.Z-SNAPSHOT.
    // SNAPSHOT tag (X.Y.Z-SNAPSHOT or X.Y.Z-SNAPSHOT.N): pom must equal tag with .N stripped.
    // Stable tag (X.Y.Z): pom with -SNAPSHOT stripped must equal tag.
    const tagBaseVersion = tagVersion.replace(/-SNAPSHOT\.\d+$/, '-SNAPSHOT');
    const actualBaseVersion = actualVersion.replace(/-SNAPSHOT$/, '');
    if (actualVersion === tagBaseVersion || actualBaseVersion === tagVersion) {
      return { ok: true };
    }
    return {
      ok: false,
      error: `${componentType} version mismatch - pom.xml has '${actualVersion}', tag expects '${tagBaseVersion}'`,
    };
  }

  // CLI and TypeScript SDK use standard npm version comparison
  const versionMatches = (actual, expected) => {
    if (isStable) {
      const baseVersion = actual?.replace(/-.*$/, '');
      return baseVersion === expected;
    }
    return actual === expected;
  };

  if (!versionMatches(actualVersion, tagVersion)) {
    return {
      ok: false,
      error: `${componentType} version mismatch - expected '${tagVersion}', got '${actualVersion}'`,
    };
  }

  return { ok: true };
}

// CLI entrypoint - skip when imported as a module for testing
const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isDirectRun) {
  const tag = process.argv[2];
  if (!tag) {
    console.error('Usage: node scripts/version-check.js <commit-tag>');
    console.error(
      'Example: node scripts/version-check.js release-cli-1.2.3-beta.0',
    );
    process.exit(1);
  }

  const result = checkVersions(tag, process.cwd());
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(`Version check passed - ${parseTag(tag).tagVersion}`);
}
