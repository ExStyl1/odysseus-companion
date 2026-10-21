import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : object(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v;
export const encode = (v) => JSON.stringify(stable(v));
export const digest = (bytes) =>
  bytes === undefined ? null : createHash('sha256').update(bytes).digest('hex');
export const equivalent = (a, b) => encode(a) === encode(b);
export function contained(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}
export function noLinks(path) {
  for (let p = resolve(path); ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink())
      throw new Error('Personal sync refuses symbolic links');
    if (p === dirname(p)) break;
  }
}
export function bytes(path) {
  noLinks(path);
  try {
    return readFileSync(path);
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
}
// Strict JSON is intentional: ambiguous or incomplete personal data is never repaired by overwriting it.
export function document(path, fallback = {}) {
  const value = bytes(path);
  if (!value) return structuredClone(fallback);
  try {
    const parsed = JSON.parse(value);
    if (!object(parsed)) throw Error();
    return parsed;
  } catch {
    throw new Error(`Invalid personal JSON: ${path}`);
  }
}
export function files(root, extension) {
  noLinks(root);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw Error('Personal sync refuses symbolic links');
    return entry.isDirectory() ? files(path, extension) : path.endsWith(extension) ? [path] : [];
  });
}
export function privateWrite(path, value) {
  noLinks(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}
export class PersonalTransaction {
  constructor(privateDir, check = false) {
    this.privateDir = privateDir;
    this.check = check;
    this.reads = new Map();
    this.writes = new Map();
  }
  read(path) {
    if (!this.reads.has(path)) this.reads.set(path, bytes(path));
    return this.reads.get(path);
  }
  json(path, fallback = {}) {
    const b = this.read(path);
    if (b === undefined) return structuredClone(fallback);
    try {
      const v = JSON.parse(b);
      if (!object(v)) throw Error();
      return v;
    } catch {
      throw Error(`Invalid personal JSON: ${path}`);
    }
  }
  put(path, value) {
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const old = this.read(path);
    if (!old?.equals(content)) this.writes.set(path, content);
  }
  putJson(path, value) {
    this.put(path, JSON.stringify(value, null, 2) + '\n');
  }
  commit() {
    for (const [path, original] of this.reads)
      if (digest(bytes(path)) !== digest(original))
        throw Error(`Personal data changed during sync; retry: ${path}`);
    const changes = [...this.writes.keys()];
    if (this.check || !changes.length) return changes;
    const backup = join(this.privateDir, 'backups', `${Date.now()}-${randomUUID()}`);
    mkdirSync(backup, { recursive: true, mode: 0o700 });
    const journal = changes.map((path, i) => ({
      path,
      file: `${i}.bak`,
      existed: this.reads.get(path) !== undefined,
      after: digest(this.writes.get(path)),
    }));
    journal.forEach((entry, i) => {
      const original = this.reads.get(entry.path);
      if (original !== undefined) privateWrite(join(backup, `${i}.bak`), original);
    });
    privateWrite(join(backup, 'manifest.json'), JSON.stringify(journal, null, 2));
    // A durable recovery manifest is written before the first native file changes.
    privateWrite(join(this.privateDir, 'pending.json'), JSON.stringify({ backup, journal }));
    const applied = [];
    try {
      for (const path of changes) {
        if (digest(bytes(path)) !== digest(this.reads.get(path)))
          throw Error('Concurrent personal writer detected');
        privateWrite(path, this.writes.get(path));
        applied.push(path);
      }
      unlinkSync(join(this.privateDir, 'pending.json'));
    } catch (error) {
      for (const path of applied.reverse()) {
        if (digest(bytes(path)) !== digest(this.writes.get(path))) continue; // never roll back a newer app write
        const old = this.reads.get(path);
        if (old === undefined) unlinkSync(path);
        else privateWrite(path, old);
      }
      throw error;
    }
    return changes;
  }
}
export function reconcile(state, key, cli, desktop, report) {
  const prior = state.fields[key];
  let selected;
  if (equivalent(cli, desktop)) selected = cli;
  else if (!prior) {
    if (cli === undefined) selected = desktop;
    else if (desktop === undefined) selected = cli;
    else {
      report.conflicts.push(key);
      return { conflict: true };
    }
  } else {
    const cliChanged = !equivalent(cli, prior.cli),
      desktopChanged = !equivalent(desktop, prior.desktop);
    if (cliChanged && desktopChanged) {
      report.conflicts.push(key);
      return { conflict: true };
    }
    selected = cliChanged ? cli : desktopChanged ? desktop : prior.value;
  }
  return {
    value: selected,
    accept(...values) {
      const c = values.length > 0 ? values[0] : selected,
        d = values.length > 1 ? values[1] : selected;
      state.fields[key] = { value: selected, cli: c, desktop: d };
    },
  };
}
