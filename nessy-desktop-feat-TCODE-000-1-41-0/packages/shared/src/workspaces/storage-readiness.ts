import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmdirSync, type Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CONFIG_DIR, DEFAULT_CONFIG_DIR, IS_DEFAULT_CONFIG_DIR, STORAGE_LAYOUT_VERSION } from '../config/paths.ts';
import {
  DurableFsError,
  atomicWriteDurableFileSync,
  classifyDurabilityError,
  renameDurablySync,
  syncDirectory,
  unlinkDurablySync,
} from '../utils/durable-fs.ts';

export { DEFAULT_CONFIG_DIR, IS_DEFAULT_CONFIG_DIR, STORAGE_LAYOUT_VERSION };

export interface StorageHostLease {
  assertHeld(): void;
}

export interface VerifiedStorageLayoutV2 {
  readonly storageLayoutVersion: 2;
  readonly verificationId: string;
}

export type StorageReadinessBlockedCode =
  | 'host-lease-missing'
  | 'unsafe-root'
  | 'custom-root-reset-required'
  | 'invalid-marker'
  | 'path-collision'
  | 'corrupt-v2'
  | 'unsupported-version'
  | 'sharing-violation'
  | 'durability-failed';

export type StorageReadinessResult =
  | { status: 'ready' | 'initialized' | 'quarantined'; layout: VerifiedStorageLayoutV2; quarantinePath?: string }
  | { status: 'blocked'; code: StorageReadinessBlockedCode; diagnosticPath?: string };

type MarkerPhase = 'prepared' | 'legacy-quarantined' | 'v2-installed';

interface CutoverMarker {
  version: 1;
  transactionId: string;
  phase: MarkerPhase;
  configDir: string;
  stagingPath: string;
  quarantinePath: string;
}

type RootState = 'absent' | 'unmarked' | 'legacy' | 'v2';

const V2_DIRECTORIES = ['workspaces', 'sessions', 'plugins'] as const;
const MARKER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class BlockedStorageReadinessError extends Error {
  constructor(readonly code: StorageReadinessBlockedCode) {
    super(code);
  }
}

function blocked(code: StorageReadinessBlockedCode): never {
  throw new BlockedStorageReadinessError(code);
}

function layout(): VerifiedStorageLayoutV2 {
  return { storageLayoutVersion: STORAGE_LAYOUT_VERSION, verificationId: randomUUID() };
}

function safeLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isSafeDirectory(stat: Stats | null): boolean {
  return !!stat && stat.isDirectory() && !stat.isSymbolicLink();
}

function isSafeRegularFile(stat: Stats | null): boolean {
  return !!stat && stat.isFile() && !stat.isSymbolicLink();
}

function assertHeld(hostLease: StorageHostLease): void {
  try {
    hostLease.assertHeld();
  } catch {
    blocked('host-lease-missing');
  }
}

function assertSafeParent(root: string): string {
  const parent = dirname(root);
  const ancestors: string[] = [];
  for (let current = parent; ; current = dirname(current)) {
    ancestors.push(current);
    if (dirname(current) === current) break;
  }
  for (const path of ancestors.reverse()) {
    if (!isSafeDirectory(safeLstat(path))) blocked('unsafe-root');
  }
  return parent;
}

function siblingStem(root: string): string {
  return basename(root).replace(/^\./, '');
}

function markerPath(root: string): string {
  return join(dirname(root), `.${siblingStem(root)}.cutover-v2.json`);
}

function stagingPath(root: string, transactionId: string): string {
  return join(dirname(root), `.${siblingStem(root)}.v2-staging.${transactionId}`);
}

function quarantinePath(root: string, transactionId: string): string {
  return join(dirname(root), `${basename(root)}.legacy-v1.${transactionId}`);
}

function assertSafeAbsent(path: string): void {
  if (safeLstat(path)) blocked('path-collision');
}

function readLayoutVersion(root: string): number | undefined {
  const configPath = join(root, 'config.json');
  const configStat = safeLstat(configPath);
  if (!configStat) return undefined;
  if (!isSafeRegularFile(configStat)) blocked('unsafe-root');

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    blocked('invalid-marker');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) blocked('invalid-marker');
  const version = (parsed as { storageLayoutVersion?: unknown }).storageLayoutVersion;
  if (version === undefined) return undefined;
  if (typeof version !== 'number' || !Number.isInteger(version)) blocked('invalid-marker');
  return version;
}

function isVerifiedV2Tree(root: string): boolean {
  if (!isSafeDirectory(safeLstat(root))) return false;
  if (readLayoutVersion(root) !== STORAGE_LAYOUT_VERSION) return false;
  return V2_DIRECTORIES.every(name => isSafeDirectory(safeLstat(join(root, name))));
}

function inspectRoot(root: string): RootState {
  const stat = safeLstat(root);
  if (!stat) return 'absent';
  if (!isSafeDirectory(stat)) blocked('unsafe-root');

  const configStat = safeLstat(join(root, 'config.json'));
  if (!configStat) return 'unmarked';
  if (!isSafeRegularFile(configStat)) blocked('unsafe-root');

  const version = readLayoutVersion(root);
  if (version === undefined || version === 1) return 'legacy';
  if (version !== STORAGE_LAYOUT_VERSION) blocked('unsupported-version');
  if (!isVerifiedV2Tree(root)) blocked('corrupt-v2');
  return 'v2';
}

function markerFor(root: string, transactionId: string, phase: MarkerPhase): CutoverMarker {
  return {
    version: 1,
    transactionId,
    phase,
    configDir: root,
    stagingPath: stagingPath(root, transactionId),
    quarantinePath: quarantinePath(root, transactionId),
  };
}

function assertMarkerPermissions(stat: Stats): void {
  if (process.platform === 'win32') return;
  if ((stat.mode & 0o777) !== 0o600) blocked('invalid-marker');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) blocked('invalid-marker');
}

function readMarker(root: string): CutoverMarker | null {
  const path = markerPath(root);
  const stat = safeLstat(path);
  if (!stat) return null;
  if (!isSafeRegularFile(stat)) blocked('invalid-marker');
  assertMarkerPermissions(stat);

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    blocked('invalid-marker');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) blocked('invalid-marker');

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ['configDir', 'phase', 'quarantinePath', 'stagingPath', 'transactionId', 'version'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) blocked('invalid-marker');
  if (record.version !== 1 || typeof record.transactionId !== 'string' || !MARKER_UUID.test(record.transactionId)) {
    blocked('invalid-marker');
  }
  if (record.phase !== 'prepared' && record.phase !== 'legacy-quarantined' && record.phase !== 'v2-installed') {
    blocked('invalid-marker');
  }

  const expected = markerFor(root, record.transactionId, record.phase);
  if (
    record.configDir !== expected.configDir
    || record.stagingPath !== expected.stagingPath
    || record.quarantinePath !== expected.quarantinePath
  ) {
    blocked('invalid-marker');
  }
  return expected;
}

function sameMarker(left: CutoverMarker | null, right: CutoverMarker): boolean {
  return !!left
    && left.transactionId === right.transactionId
    && left.phase === right.phase
    && left.configDir === right.configDir
    && left.stagingPath === right.stagingPath
    && left.quarantinePath === right.quarantinePath;
}

function assertExpectedMarker(root: string, expected: CutoverMarker | null): void {
  const current = readMarker(root);
  if (expected === null) {
    if (current) blocked('path-collision');
    return;
  }
  if (!sameMarker(current, expected)) blocked('invalid-marker');
}

function writeMarker(
  root: string,
  hostLease: StorageHostLease,
  transactionId: string,
  phase: MarkerPhase,
  expected: CutoverMarker | null,
): CutoverMarker {
  assertHeld(hostLease);
  assertSafeParent(root);
  assertExpectedMarker(root, expected);
  const next = markerFor(root, transactionId, phase);
  atomicWriteDurableFileSync(markerPath(root), JSON.stringify(next), {
    mode: 0o600,
    noReplace: expected === null,
  });
  if (!sameMarker(readMarker(root), next)) blocked('invalid-marker');
  return next;
}

function retireMarker(root: string, hostLease: StorageHostLease, marker: CutoverMarker): void {
  assertHeld(hostLease);
  assertSafeParent(root);
  assertExpectedMarker(root, marker);
  unlinkDurablySync(markerPath(root));
}

function createStaging(root: string, hostLease: StorageHostLease, transactionId: string): string {
  const parent = assertSafeParent(root);
  const staging = stagingPath(root, transactionId);
  assertSafeAbsent(staging);
  assertHeld(hostLease);
  try {
    mkdirSync(staging, { mode: 0o700 });
  } catch (error) {
    throw classifyDurabilityError(error);
  }
  syncDirectory(parent);

  for (const name of V2_DIRECTORIES) {
    assertHeld(hostLease);
    mkdirSync(join(staging, name), { mode: 0o700 });
  }
  syncDirectory(staging);
  assertHeld(hostLease);
  atomicWriteDurableFileSync(join(staging, 'config.json'), JSON.stringify({
    storageLayoutVersion: STORAGE_LAYOUT_VERSION,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  }), { mode: 0o600 });
  if (!isVerifiedV2Tree(staging)) blocked('corrupt-v2');
  return staging;
}

function installFreshRoot(root: string, hostLease: StorageHostLease): StorageReadinessResult {
  const parent = assertSafeParent(root);
  const transactionId = randomUUID();
  const staging = createStaging(root, hostLease, transactionId);
  assertHeld(hostLease);
  assertSafeParent(root);
  if (safeLstat(root)) {
    blocked('path-collision');
  }
  assertHeld(hostLease);
  assertSafeParent(root);
  renameDurablySync(staging, root);
  if (!isVerifiedV2Tree(root)) blocked('corrupt-v2');
  return { status: 'initialized', layout: layout() };
}

function removeEmptyRoot(root: string, hostLease: StorageHostLease): boolean {
  assertHeld(hostLease);
  const parent = assertSafeParent(root);
  if (!isSafeDirectory(safeLstat(root))) blocked('unsafe-root');
  try {
    rmdirSync(root);
    syncDirectory(parent);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return false;
    }
    throw classifyDurabilityError(error);
  }
}

function assertSafeQuarantine(marker: CutoverMarker): void {
  if (!isSafeDirectory(safeLstat(marker.quarantinePath))) blocked('path-collision');
}

function installStagedV2(root: string, hostLease: StorageHostLease, marker: CutoverMarker): void {
  if (!isVerifiedV2Tree(marker.stagingPath)) blocked('path-collision');
  if (safeLstat(root)) blocked('path-collision');
  assertHeld(hostLease);
  assertSafeParent(root);
  assertExpectedMarker(root, marker);
  renameDurablySync(marker.stagingPath, root);
  if (!isVerifiedV2Tree(root)) blocked('corrupt-v2');
}

function finalizeInstalled(root: string, hostLease: StorageHostLease, marker: CutoverMarker): StorageReadinessResult {
  if (!isVerifiedV2Tree(root)) blocked('corrupt-v2');
  assertSafeQuarantine(marker);
  if (safeLstat(marker.stagingPath)) blocked('path-collision');
  const installed = marker.phase === 'v2-installed'
    ? marker
    : writeMarker(root, hostLease, marker.transactionId, 'v2-installed', marker);
  retireMarker(root, hostLease, installed);
  return { status: 'ready', layout: layout() };
}

function recoverCutover(root: string, hostLease: StorageHostLease, marker: CutoverMarker): StorageReadinessResult {
  const rootState = inspectRoot(root);
  const stagingExists = !!safeLstat(marker.stagingPath);
  const quarantineExists = !!safeLstat(marker.quarantinePath);
  if (stagingExists && !isSafeDirectory(safeLstat(marker.stagingPath))) blocked('path-collision');
  if (quarantineExists && !isSafeDirectory(safeLstat(marker.quarantinePath))) blocked('path-collision');

  if (marker.phase === 'prepared') {
    if (rootState === 'legacy' && stagingExists && !quarantineExists) {
      assertHeld(hostLease);
      assertSafeParent(root);
      const currentState = inspectRoot(root);
      if (currentState !== 'legacy' || !isVerifiedV2Tree(marker.stagingPath) || safeLstat(marker.quarantinePath)) {
        blocked('path-collision');
      }
      assertExpectedMarker(root, marker);
      renameDurablySync(root, marker.quarantinePath);
      const legacyMarker = writeMarker(root, hostLease, marker.transactionId, 'legacy-quarantined', marker);
      installStagedV2(root, hostLease, legacyMarker);
      const installedMarker = writeMarker(root, hostLease, marker.transactionId, 'v2-installed', legacyMarker);
      finalizeInstalled(root, hostLease, installedMarker);
      return { status: 'quarantined', layout: layout(), quarantinePath: marker.quarantinePath };
    }
    if (rootState === 'absent' && stagingExists && quarantineExists) {
      assertSafeQuarantine(marker);
      const legacyMarker = writeMarker(root, hostLease, marker.transactionId, 'legacy-quarantined', marker);
      installStagedV2(root, hostLease, legacyMarker);
      const installedMarker = writeMarker(root, hostLease, marker.transactionId, 'v2-installed', legacyMarker);
      finalizeInstalled(root, hostLease, installedMarker);
      return { status: 'quarantined', layout: layout(), quarantinePath: marker.quarantinePath };
    }
    blocked('path-collision');
  }

  if (marker.phase === 'legacy-quarantined') {
    if (rootState === 'absent' && stagingExists && quarantineExists) {
      assertSafeQuarantine(marker);
      installStagedV2(root, hostLease, marker);
      const installedMarker = writeMarker(root, hostLease, marker.transactionId, 'v2-installed', marker);
      finalizeInstalled(root, hostLease, installedMarker);
      return { status: 'quarantined', layout: layout(), quarantinePath: marker.quarantinePath };
    }
    if (rootState === 'v2' && !stagingExists && quarantineExists) {
      return finalizeInstalled(root, hostLease, marker);
    }
    blocked('path-collision');
  }

  if (rootState !== 'v2' || stagingExists || !quarantineExists) blocked('path-collision');
  return finalizeInstalled(root, hostLease, marker);
}

function quarantineLegacyRoot(root: string, hostLease: StorageHostLease): StorageReadinessResult {
  const transactionId = randomUUID();
  const staging = createStaging(root, hostLease, transactionId);
  const marker = markerFor(root, transactionId, 'prepared');
  if (staging !== marker.stagingPath) blocked('path-collision');
  assertSafeAbsent(marker.quarantinePath);
  const preparedMarker = writeMarker(root, hostLease, transactionId, 'prepared', null);

  assertHeld(hostLease);
  assertSafeParent(root);
  if (inspectRoot(root) !== 'legacy' || !isVerifiedV2Tree(marker.stagingPath) || safeLstat(marker.quarantinePath)) {
    blocked('path-collision');
  }
  assertExpectedMarker(root, preparedMarker);
  renameDurablySync(root, marker.quarantinePath);
  const legacyMarker = writeMarker(root, hostLease, transactionId, 'legacy-quarantined', preparedMarker);
  installStagedV2(root, hostLease, legacyMarker);
  const installedMarker = writeMarker(root, hostLease, transactionId, 'v2-installed', legacyMarker);
  finalizeInstalled(root, hostLease, installedMarker);
  return { status: 'quarantined', layout: layout(), quarantinePath: marker.quarantinePath };
}

export function storageReadinessBlockedCodeFor(error: unknown): StorageReadinessBlockedCode {
  if (error instanceof BlockedStorageReadinessError) return error.code;
  if (error instanceof DurableFsError) return error.code;
  return 'durability-failed';
}

function asBlockedResult(error: unknown): StorageReadinessResult {
  return { status: 'blocked', code: storageReadinessBlockedCodeFor(error) };
}

export async function ensureStorageLayoutV2(hostLease: StorageHostLease): Promise<StorageReadinessResult> {
  try {
    assertHeld(hostLease);
    const root = resolve(CONFIG_DIR);
    assertSafeParent(root);

    if (!IS_DEFAULT_CONFIG_DIR) {
      if (safeLstat(markerPath(root))) blocked('path-collision');
      const state = inspectRoot(root);
      if (state === 'legacy') blocked('custom-root-reset-required');
      if (state === 'v2') return { status: 'ready', layout: layout() };
      if (state === 'absent') return installFreshRoot(root, hostLease);
      if (removeEmptyRoot(root, hostLease)) return installFreshRoot(root, hostLease);
      blocked('custom-root-reset-required');
    }

    const marker = readMarker(root);
    if (marker) return recoverCutover(root, hostLease, marker);

    const state = inspectRoot(root);
    if (state === 'v2') return { status: 'ready', layout: layout() };
    if (state === 'absent') return installFreshRoot(root, hostLease);
    if (state === 'legacy') return quarantineLegacyRoot(root, hostLease);
    if (removeEmptyRoot(root, hostLease)) return installFreshRoot(root, hostLease);
    blocked('invalid-marker');
  } catch (error) {
    return asBlockedResult(error);
  }
}
