import { createWriteStream } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { open, type Entry, type ZipFile } from 'yauzl';

const MAX_MCPB_ENTRIES = 10_000;
const MAX_MCPB_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_MCPB_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_MCPB_MANIFEST_BYTES = 1024 * 1024;
export const MAX_MCPB_ARCHIVE_BYTES = 256 * 1024 * 1024;

interface McpbArchivePolicy {
  serverType?: string;
  binaryEntryPoint?: string;
}

export function isZipArchive(bytes: Uint8Array): boolean {
  return bytes.length >= 4
    && bytes[0] === 0x50
    && bytes[1] === 0x4b
    && ((bytes[2] === 0x03 && bytes[3] === 0x04)
      || (bytes[2] === 0x05 && bytes[3] === 0x06)
      || (bytes[2] === 0x07 && bytes[3] === 0x08));
}

export function hasMcpbArchiveExtension(path: string): boolean {
  return /\.(?:mcpb|dxt)$/i.test(path.split(/[?#]/, 1)[0] ?? path);
}

/** Positive content identification for generic .zip files. */
export async function hasRootMcpbManifest(archivePath: string): Promise<boolean> {
  return (await readArchivePolicy(archivePath)) !== undefined;
}

export async function extractMcpbArchive(archivePath: string, targetDirectory: string): Promise<void> {
  const policy = await readArchivePolicy(archivePath);
  if (!policy) throw new Error('MCPB archive must contain a valid root manifest.json.');
  await mkdir(targetDirectory, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    open(archivePath, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error('MCPB archive could not be opened.'));
        return;
      }
      extractOpenZip(zip, targetDirectory, policy).then(resolve, reject);
    });
  });
}

async function extractOpenZip(zip: ZipFile, targetDirectory: string, policy: McpbArchivePolicy): Promise<void> {
  const paths = new Set<string>();
  let entryCount = 0;
  let extractedBytes = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    zip.on('error', fail);
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on('entry', (entry: Entry) => {
      extractEntry(entry).catch(fail);
    });

    const extractEntry = async (entry: Entry): Promise<void> => {
      entryCount += 1;
      if (entryCount > MAX_MCPB_ENTRIES) {
        throw new Error(`MCPB archive exceeds the ${MAX_MCPB_ENTRIES}-entry limit.`);
      }
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > MAX_MCPB_ENTRY_BYTES) {
        throw new Error(`MCPB entry exceeds the ${MAX_MCPB_ENTRY_BYTES}-byte limit: ${entry.fileName}`);
      }
      extractedBytes += entry.uncompressedSize;
      if (extractedBytes > MAX_MCPB_EXTRACTED_BYTES) {
        throw new Error(`MCPB archive exceeds the ${MAX_MCPB_EXTRACTED_BYTES}-byte extraction limit.`);
      }

      const relativePath = canonicalEntryPath(entry.fileName);
      const canonicalKey = canonicalPathKey(relativePath);
      if (paths.has(canonicalKey)) {
        throw new Error(`MCPB archive contains duplicate canonical path: ${entry.fileName}`);
      }
      paths.add(canonicalKey);

      const unixMode = entry.versionMadeBy >>> 8 === 3
        ? entry.externalFileAttributes >>> 16
        : 0;
      const fileType = unixMode & 0o170000;
      if (fileType === 0o120000) {
        throw new Error(`MCPB archive symlinks are not supported: ${entry.fileName}`);
      }
      const directory = entry.fileName.endsWith('/') || fileType === 0o040000;
      if (fileType !== 0 && fileType !== 0o040000 && fileType !== 0o100000) {
        throw new Error(`MCPB archive entry type is not supported: ${entry.fileName}`);
      }
      if (!directory && (unixMode & 0o111) !== 0
        && !(policy.serverType === 'binary' && relativePath === policy.binaryEntryPoint)) {
        throw new Error(`MCPB executable entry is not the declared binary server: ${entry.fileName}`);
      }

      const targetPath = join(targetDirectory, ...relativePath.split('/'));
      assertContained(targetDirectory, targetPath);
      if (directory) {
        await mkdir(targetPath, { recursive: true });
        zip.readEntry();
        return;
      }

      await mkdir(dirname(targetPath), { recursive: true });
      const stream = await new Promise<Readable>((streamResolve, streamReject) => {
        zip.openReadStream(entry, (error, readStream) => {
          if (error) streamReject(error);
          else streamResolve(readStream);
        });
      });
      let written = 0;
      stream.on('data', (chunk: Buffer) => {
        written += chunk.length;
        if (written > MAX_MCPB_ENTRY_BYTES) stream.destroy(new Error(`MCPB entry exceeds extraction limit: ${entry.fileName}`));
      });
      await pipeline(stream, createWriteStream(targetPath, {
        flags: 'wx',
        mode: unixMode ? unixMode & 0o777 : 0o600,
      }));
      if (written !== entry.uncompressedSize) {
        throw new Error(`MCPB entry size mismatch: ${entry.fileName}`);
      }
      if (unixMode) await chmod(targetPath, unixMode & 0o777);
      zip.readEntry();
    };

    zip.readEntry();
  });
}

async function readArchivePolicy(archivePath: string): Promise<McpbArchivePolicy | undefined> {
  const manifest = await readRootManifest(archivePath);
  if (!isRecord(manifest)) return undefined;
  const manifestVersion = manifest.manifest_version;
  const dxtVersion = manifest.dxt_version;
  const version = typeof manifestVersion === 'string' ? manifestVersion : dxtVersion;
  const server = manifest.server;
  if ((manifestVersion !== undefined && dxtVersion !== undefined && manifestVersion !== dxtVersion)
    || (version !== '0.1' && version !== '0.2' && version !== '0.3')
    || !isRecord(server)) return undefined;
  const serverType = typeof server.type === 'string' ? server.type : undefined;
  if (serverType !== 'node' && serverType !== 'python' && serverType !== 'binary') return undefined;
  const entryPoint = typeof server.entry_point === 'string' ? server.entry_point : undefined;
  if (!entryPoint) return undefined;
  let canonicalEntryPoint: string;
  try {
    canonicalEntryPoint = canonicalEntryPath(entryPoint);
  } catch {
    return undefined;
  }
  return {
    serverType,
    ...(serverType === 'binary' ? { binaryEntryPoint: canonicalEntryPoint } : {}),
  };
}

async function readRootManifest(archivePath: string): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
    open(archivePath, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (openError, zip) => {
      if (openError || !zip) {
        reject(openError ?? new Error('MCPB archive could not be opened.'));
        return;
      }
      let settled = false;
      const finish = (value: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      zip.on('error', fail);
      zip.on('end', () => finish(undefined));
      zip.on('entry', (entry: Entry) => {
        if (entry.fileName !== 'manifest.json') {
          zip.readEntry();
          return;
        }
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > MAX_MCPB_MANIFEST_BYTES) {
          fail(new Error('MCPB manifest exceeds the size limit.'));
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            fail(error ?? new Error('MCPB manifest could not be read.'));
            return;
          }
          const chunks: Buffer[] = [];
          let length = 0;
          stream.on('data', (chunk: Buffer) => {
            length += chunk.length;
            if (length > MAX_MCPB_MANIFEST_BYTES) stream.destroy(new Error('MCPB manifest exceeds the size limit.'));
            else chunks.push(chunk);
          });
          stream.once('error', fail);
          stream.once('end', () => {
            try {
              finish(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
            } catch {
              finish(undefined);
            }
          });
        });
      });
      zip.readEntry();
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function canonicalEntryPath(input: string): string {
  if (!input || input.includes('\0') || input.includes('\\') || input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
    throw new Error(`MCPB archive entry would escape staging: ${input}`);
  }
  const parts = input.replace(/\/$/, '').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`MCPB archive entry would escape staging: ${input}`);
  }
  return parts.join('/').normalize('NFC');
}

function canonicalPathKey(path: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? path.toLocaleLowerCase('en-US')
    : path;
}

function assertContained(root: string, target: string): void {
  const inside = relative(root, target);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || inside.includes('\0')) {
    throw new Error(`MCPB archive entry would escape staging: ${target}`);
  }
}
