/**
 * Normalizes multi-platform release artifacts into the flat update-feed shape
 * consumed by electron-updater.
 *
 * This copies only app release metadata and the artifacts referenced by that
 * metadata. Aion's web-cli tarball/checksum copy is intentionally omitted:
 * Nessy ships the bundled CLI inside the Electron app resources.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  canonicalMetadataName,
  collectReferencedArtifacts,
  inferTargetFromMetadata,
  parseUpdateMetadata,
  renderUpdateMetadata,
  sha512Base64,
} from './verify-update-feed.mjs';

const REJECTED_METADATA_NAMES = new Set(['builder-debug.yml']);

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const result = prepareReleaseAssets(parseArgs(process.argv.slice(2)));
  for (const line of result.log) {
    console.log(line);
  }
  console.log(
    `release assets normalized: ${result.metadata.length} metadata file(s), ` +
      `${result.artifacts.length} artifact(s) -> ${result.outputDir}`,
  );
}

function parseArgs(argv) {
  const parsed = {
    artifactsDir: null,
    outputDir: 'release',
  };

  for (const arg of argv) {
    if (arg.startsWith('--artifacts-dir=')) {
      parsed.artifactsDir = arg.slice('--artifacts-dir='.length);
      continue;
    }
    if (arg.startsWith('--input-dir=')) {
      parsed.artifactsDir = arg.slice('--input-dir='.length);
      continue;
    }
    if (arg.startsWith('--out-dir=')) {
      parsed.outputDir = arg.slice('--out-dir='.length);
      continue;
    }
    if (arg.startsWith('--output-dir=')) {
      parsed.outputDir = arg.slice('--output-dir='.length);
      continue;
    }
    fail(`Unknown argument: ${arg}`);
  }

  if (!parsed.artifactsDir) {
    fail('--artifacts-dir is required');
  }
  if (!parsed.outputDir) {
    fail('--out-dir must not be empty');
  }
  return parsed;
}

export function prepareReleaseAssets({ artifactsDir, outputDir }) {
  const inputRoot = resolve(artifactsDir);
  const outRoot = resolve(outputDir);

  if (!existsSync(inputRoot) || !statSync(inputRoot).isDirectory()) {
    throw new Error(`artifacts directory was not found: ${artifactsDir}`);
  }

  mkdirSync(outRoot, { recursive: true });

  const files = listFiles(inputRoot);
  const byBasename = new Map();
  for (const file of files) {
    const name = basename(file);
    if (!byBasename.has(name)) {
      byBasename.set(name, file);
    }
  }

  const metadataCandidates = files
    .filter((file) => file.endsWith('.yml'))
    .filter((file) => !REJECTED_METADATA_NAMES.has(basename(file)))
    .map((file) => {
      const parsed = parseUpdateMetadata(readFileSync(file, 'utf8'), {
        fileName: basename(file),
      });
      if (!parsed.primary) {
        return null;
      }
      const target = inferTargetFromMetadata(parsed, basename(file));
      return { file, parsed, target };
    })
    .filter(Boolean);

  const selectedByOutputName = new Map();
  for (const candidate of metadataCandidates) {
    const outputName = canonicalMetadataName(
      candidate.target.platform,
      candidate.target.arch,
    );
    const existing = selectedByOutputName.get(outputName);
    if (
      !existing ||
      metadataPreference(candidate.file, outputName) < metadataPreference(existing.file, outputName)
    ) {
      selectedByOutputName.set(outputName, candidate);
    }
  }

  const copiedArtifacts = new Map();
  const writtenMetadata = [];
  const log = [];

  for (const [outputName, candidate] of [...selectedByOutputName.entries()].sort()) {
    const referenced = collectReferencedArtifacts(candidate.parsed, basename(candidate.file));
    const filesForMetadata = [];

    for (const entry of referenced) {
      const sourcePath = byBasename.get(entry.name);
      if (!sourcePath) {
        throw new Error(
          `${basename(candidate.file)} references ${entry.name}, but no matching artifact exists under ${artifactsDir}`,
        );
      }
      const outputPath = join(outRoot, entry.name);
      if (!copiedArtifacts.has(entry.name)) {
        copyFileSync(sourcePath, outputPath);
        copiedArtifacts.set(entry.name, outputPath);
      }
      filesForMetadata.push({
        url: entry.name,
        sha512: sha512Base64(readFileSync(outputPath)),
        size: statSync(outputPath).size,
      });
    }

    const primaryName = basename(candidate.parsed.primary.path);
    const primaryFile = filesForMetadata.find((file) => file.url === primaryName);
    if (!primaryFile) {
      throw new Error(
        `${basename(candidate.file)} primary path ${candidate.parsed.primary.path} was not copied`,
      );
    }

    writeFileSync(
      join(outRoot, outputName),
      renderUpdateMetadata({
        version: candidate.parsed.version,
        path: primaryFile.url,
        sha512: primaryFile.sha512,
        files: filesForMetadata,
      }),
      'utf8',
    );
    writtenMetadata.push(outputName);
    log.push(
      `${basename(candidate.file)} -> ${outputName} (${candidate.target.platform}/${candidate.target.arch})`,
    );
  }

  return {
    outputDir: outRoot,
    metadata: writtenMetadata,
    artifacts: [...copiedArtifacts.keys()].sort(),
    log,
  };
}

function metadataPreference(file, outputName) {
  const name = basename(file);
  if (name === outputName) {
    return 0;
  }
  if (name.startsWith('latest')) {
    return 1;
  }
  return 2;
}

function listFiles(root) {
  const results = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        results.push(path);
      }
    }
  };
  visit(root);
  return results;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
