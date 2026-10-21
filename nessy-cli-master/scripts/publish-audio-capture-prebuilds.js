#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, isMainModule, readOptionValue } from './release-script-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const audioCaptureDir = path.join(rootDir, 'packages', 'audio-capture');
const prebuildsDir = path.join(audioCaptureDir, 'prebuilds');
const defaultBucket = process.env.AWS_BUCKET_DIR || 'nestor-companion';
const defaultPrefix = 'nessy-cli/audio-capture';
const defaultNodeVersion = process.env.NODE_VERSION || '22.22.2';

if (isMainModule(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return;
  }

  const prebuildDirName = getPrebuildDirName();
  const prebuildDir = path.join(prebuildsDir, prebuildDirName);

  if (!args.noBuild) {
    runNpm(['run', 'build:ts', '--workspace=packages/audio-capture']);
    if (args.insecure) {
      console.warn('TLS certificate verification is disabled for prebuildify.');
    }
    runNpm(buildPrebuildifyArgs(args.nodeVersion), getPrebuildifyEnv(args));
  }

  assertPrebuild(prebuildDir);
  uploadPrebuild({
    bucket: args.bucket,
    latest: args.latest,
    prefix: args.prefix,
    prebuildDir,
    prebuildDirName,
    version: args.version,
  });
}

function parseArgs(argv) {
  const args = {
    bucket: defaultBucket,
    help: false,
    insecure: false,
    latest: true,
    noBuild: false,
    nodeVersion: defaultNodeVersion,
    prefix: defaultPrefix,
    version: readRootVersion(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--bucket':
        args.bucket = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--prefix':
        args.prefix = readOptionValue(argv, index, arg).replace(
          /^\/+|\/+$/g,
          '',
        );
        index += 1;
        break;
      case '--version':
        args.version = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--node-version':
        args.nodeVersion = readOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--no-build':
        args.noBuild = true;
        break;
      case '--no-latest':
        args.latest = false;
        break;
      case '--insecure':
        args.insecure = true;
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  if (!args.bucket) {
    fail('--bucket requires a value');
  }
  if (!args.prefix) {
    fail('--prefix requires a value');
  }
  if (!args.version) {
    fail('--version requires a value');
  }

  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/publish-audio-capture-prebuilds.js [options]

Builds @nestor/nessy-cli-audio-capture for the current native platform and
uploads only that platform's prebuild directory to S3.

Options:
  --version VERSION       Release version. Defaults to root package.json.
  --node-version VERSION  Node target for prebuildify. Defaults to NODE_VERSION
                          or ${defaultNodeVersion}.
  --bucket NAME           S3 bucket. Defaults to AWS_BUCKET_DIR or ${defaultBucket}.
  --prefix PREFIX         S3 key prefix. Defaults to ${defaultPrefix}.
  --no-build              Upload existing prebuilds without rebuilding.
  --no-latest             Do not also upload to the latest prefix.
  --insecure              Disable TLS certificate verification for prebuildify.
  -h, --help              Show this help message.
`);
}

function readRootVersion() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'),
  );
  return packageJson.version;
}

function getPrebuildDirName() {
  const platform = process.platform;
  const arch = process.arch;
  const supportedPlatforms = new Set(['darwin', 'linux', 'win32']);
  const supportedArchitectures = new Set(['arm64', 'x64']);
  if (!supportedPlatforms.has(platform) || !supportedArchitectures.has(arch)) {
    fail(`Unsupported audio-capture prebuild target: ${platform}-${arch}`);
  }
  return `${platform}-${arch}`;
}

function assertPrebuild(prebuildDir) {
  if (!fs.existsSync(prebuildDir)) {
    fail(`Prebuild directory not found: ${prebuildDir}`);
  }
  if (!findNodeFile(prebuildDir)) {
    fail(`No .node binary found in ${prebuildDir}`);
  }
}

function findNodeFile(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && findNodeFile(fullPath)) {
      return true;
    }
    if (entry.isFile() && entry.name.endsWith('.node')) {
      return true;
    }
  }
  return false;
}

function uploadPrebuild({
  bucket,
  latest,
  prefix,
  prebuildDir,
  prebuildDirName,
  version,
}) {
  const destinations = [
    `s3://${bucket}/${prefix}/${version}/prebuilds/${prebuildDirName}/`,
  ];
  if (latest) {
    destinations.push(
      `s3://${bucket}/${prefix}/latest/prebuilds/${prebuildDirName}/`,
    );
  }

  for (const destination of destinations) {
    console.log(`Uploading ${prebuildDirName} to ${destination}`);
    execFileSync(
      process.platform === 'win32' ? 's3cmd.cmd' : 's3cmd',
      ['put', '--recursive', `${prebuildDir}/`, destination],
      {
        cwd: rootDir,
        stdio: 'inherit',
      },
    );
  }
}

function runNpm(args, env = {}) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCommand, args, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
}

function buildPrebuildifyArgs(nodeVersion) {
  const args = [
    'run',
    'prebuildify',
    '--workspace=packages/audio-capture',
    '--',
  ];
  if (nodeVersion) {
    args.push('--target', nodeVersion);
  }
  return args;
}

function getPrebuildifyEnv(args) {
  if (!args.insecure) {
    return {};
  }
  return {
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    npm_config_strict_ssl: 'false',
  };
}
