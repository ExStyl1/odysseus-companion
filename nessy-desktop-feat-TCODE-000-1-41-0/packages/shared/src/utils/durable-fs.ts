import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export type ConfigWriteStep =
  | 'before-temp-write'
  | 'after-temp-write'
  | 'after-file-sync'
  | 'before-rename'
  | 'after-rename';

export class AtomicConfigWriteError extends Error {
  readonly committed = true;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'AtomicConfigWriteError';
  }
}

export class DurableFsError extends Error {
  constructor(
    readonly code: 'sharing-violation' | 'durability-failed',
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'DurableFsError';
  }
}

export interface DurableWriteResult {
  readonly directoryDurable: boolean;
}

export interface DurableWriteOptions {
  readonly mode?: number;
  readonly failpoint?: (step: ConfigWriteStep) => void;
  readonly noReplace?: boolean;
}

let writeSequence = 0;

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyDurabilityError(error: unknown, platform = process.platform): DurableFsError {
  const code = errorCode(error);
  if (platform === 'win32' && (code === 'EPERM' || code === 'EBUSY')) {
    return new DurableFsError('sharing-violation', error);
  }
  return new DurableFsError('durability-failed', error);
}

export function classifyDirectoryFlushError(error: unknown, platform = process.platform): 'unsupported' | 'failed' {
  const code = errorCode(error);
  return platform === 'win32' && (
    code === 'ENOTSUP'
    || code === 'EINVAL'
    || code === 'EISDIR'
    || (code === 'EPERM' && /operation not permitted.*open/i.test(errorMessage(error)))
  )
    ? 'unsupported'
    : 'failed';
}

export function syncDirectory(path: string): DurableWriteResult {
  let descriptor: number;
  try {
    descriptor = openSync(path, 'r');
  } catch (error) {
    if (classifyDirectoryFlushError(error) === 'unsupported') return { directoryDurable: false };
    throw classifyDurabilityError(error);
  }

  try {
    fsyncSync(descriptor);
    return { directoryDurable: true };
  } catch (error) {
    if (classifyDirectoryFlushError(error) === 'unsupported') return { directoryDurable: false };
    throw classifyDurabilityError(error);
  } finally {
    closeSync(descriptor);
  }
}

export function renameDurablySync(sourcePath: string, targetPath: string): DurableWriteResult {
  const sourceParent = resolve(dirname(sourcePath));
  const targetParent = resolve(dirname(targetPath));
  if (sourceParent !== targetParent) {
    throw new DurableFsError('durability-failed', new Error('Durable rename requires the same parent directory'));
  }

  try {
    renameSync(sourcePath, targetPath);
  } catch (error) {
    throw classifyDurabilityError(error);
  }
  return syncDirectory(targetParent);
}

export function unlinkDurablySync(path: string): DurableWriteResult {
  try {
    unlinkSync(path);
  } catch (error) {
    throw classifyDurabilityError(error);
  }
  return syncDirectory(dirname(path));
}

export function atomicWriteDurableFileSync(
  filePath: string,
  data: string,
  options: DurableWriteOptions = {},
): DurableWriteResult {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.${Date.now()}.${writeSequence++}.tmp`);
  let tempExists = false;
  let committed = false;
  let descriptor: number | null = null;

  try {
    options.failpoint?.('before-temp-write');
    descriptor = openSync(tempPath, 'wx', options.mode ?? 0o600);
    tempExists = true;
    writeFileSync(descriptor, data, 'utf-8');
    options.failpoint?.('after-temp-write');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    options.failpoint?.('after-file-sync');
    options.failpoint?.('before-rename');

    try {
      if (options.noReplace) {
        linkSync(tempPath, filePath);
        unlinkSync(tempPath);
      } else {
        renameSync(tempPath, filePath);
      }
      tempExists = false;
    } catch (error) {
      throw classifyDurabilityError(error);
    }
    committed = true;
    options.failpoint?.('after-rename');
    return syncDirectory(directory);
  } catch (error) {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch {}
    }
    if (tempExists) {
      try { unlinkSync(tempPath); } catch {}
    }
    if (committed) throw new AtomicConfigWriteError(error);
    throw error;
  }
}

export function atomicWriteConfigFileSync(
  filePath: string,
  data: string,
  failpoint?: (step: ConfigWriteStep) => void,
): void {
  atomicWriteDurableFileSync(filePath, data, { mode: 0o600, failpoint });
}
