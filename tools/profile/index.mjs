import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value) =>
  value === undefined ? null : createHash('sha256').update(value).digest('hex');
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : record(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
const json = (value) => Buffer.from(`${JSON.stringify(stable(value), null, 2)}\n`);

function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

// Project capability readers reject symlinks outside the project too. Copies
// preserve that boundary and keep an app update from replacing shared data.
function safePath(root, target) {
  if (!inside(root, target)) throw new Error(`Path outside profile/project: ${target}`);
  for (let path = target; inside(root, path); path = dirname(path)) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`Symlink is not managed: ${path}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (path === root) break;
  }
}

function read(root, path) {
  safePath(root, path);
  try {
    return readFileSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function document(root, path, fallback) {
  const bytes = read(root, path);
  if (!bytes) return fallback;
  try {
    return JSON.parse(bytes.toString());
  } catch {
    throw new Error(`Invalid JSON (use strict JSON, without comments): ${path}`);
  }
}

function walk(root, directory) {
  safePath(root, directory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    safePath(root, path);
    return entry.isDirectory() ? walk(root, path) : [path];
  });
}

function portableMcp(server, name) {
  const type =
    server.type ??
    (server.httpUrl ? 'http' : server.command ? 'stdio' : server.url ? 'sse' : undefined);
  if (
    server.httpUrl !== undefined &&
    (type !== 'http' || (server.url !== undefined && server.url !== server.httpUrl))
  ) {
    throw new Error(`Conflicting MCP transport URLs: ${name}`);
  }
  const normalized = { ...server, type };
  if (server.httpUrl !== undefined) normalized.url = server.httpUrl;
  delete normalized.httpUrl;
  return normalized;
}

function validateMcp(servers, label) {
  if (!record(servers)) throw new Error(`Expected mcpServers object: ${label}`);
  for (const [name, server] of Object.entries(servers)) {
    if (!name || !record(server)) throw new Error(`Invalid MCP entry: ${label} / ${name}`);
    const normalized = portableMcp(server, name);
    const type = normalized.type;
    if (type === 'stdio') {
      if (typeof server.command !== 'string' || !server.command.trim())
        throw new Error(`MCP command required: ${name}`);
      if (
        server.args !== undefined &&
        (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string'))
      ) {
        throw new Error(`MCP args must be strings: ${name}`);
      }
    } else if (type === 'http' || type === 'sse') {
      if (typeof normalized.url !== 'string' || !/^https?:\/\//.test(normalized.url))
        throw new Error(`MCP HTTP(S) URL required: ${name}`);
    } else {
      throw new Error(`Unsupported portable MCP transport for ${name}: use stdio, http or sse`);
    }
    // Scope/trust belongs to the host; sharing a config never grants approval.
    if ('scope' in server || 'trust' in server)
      throw new Error(`Remove host-specific scope/trust from MCP: ${name}`);
  }
}

function inventory(root, shared) {
  const values = new Map();
  const mcpPath = join(root, shared ? 'mcp.json' : '.mcp.json');
  const mcp = document(root, mcpPath, { mcpServers: {} });
  if (!record(mcp)) throw new Error(`Expected JSON object: ${mcpPath}`);
  validateMcp(mcp.mcpServers, mcpPath);
  for (const [name, value] of Object.entries(mcp.mcpServers))
    values.set(`mcp:${name}`, json(portableMcp(value, name)));
  const directories = shared
    ? [
        ['skills', 'skills'],
        ['agents', 'agents'],
        ['rules', 'rules'],
      ]
    : [
        ['.agents/skills', 'skills'],
        ['.nessy/agents', 'agents'],
        ['.nessy-agent/agents', 'agents'],
        ['.nessy/rules', 'rules'],
        ['.nessy-agent/rules', 'rules'],
      ];
  for (const [directory, kind] of directories) {
    for (const path of walk(root, join(root, directory))) {
      const rel = relative(join(root, directory), path).split(sep).join('/');
      if (kind !== 'skills' && !rel.endsWith('.md')) continue;
      if (kind === 'agents' && rel.includes('/'))
        throw new Error(`Portable agent definitions must be directly inside agents/: ${path}`);
      const key = `${kind}/${rel}`;
      const value = read(root, path);
      const previous = values.get(key);
      if (previous && !previous.equals(value)) {
        // During sync individual projections are read separately. Import must
        // explicitly reject two pre-existing, incompatible agent/rule variants.
        values.set(key, null);
      } else if (previous !== null) values.set(key, value);
    }
  }
  return { values, mcp, mcpPath };
}

function targets(key) {
  if (key.startsWith('skills/')) return [`.agents/${key}`];
  return [`.nessy/${key}`, `.nessy-agent/${key}`];
}

function atomicWrite(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value, { mode });
    renameSync(temporary, path);
    chmodSync(path, mode);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function transaction(changes) {
  const originals = changes.map(({ path }) => {
    try {
      return {
        path,
        value: readFileSync(path),
        mode: lstatSync(path).mode & 0o777,
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { path };
    }
  });
  try {
    for (const { path, value, mode } of changes) {
      if (value === undefined) rmSync(path, { force: true });
      else atomicWrite(path, value, mode ?? originals.find((entry) => entry.path === path)?.mode);
    }
  } catch (error) {
    const failures = [];
    for (const entry of originals.reverse()) {
      try {
        if (entry.value === undefined) rmSync(entry.path, { force: true });
        else atomicWrite(entry.path, entry.value, entry.mode);
      } catch (rollbackError) {
        failures.push(rollbackError.message);
      }
    }
    if (failures.length)
      throw new AggregateError([error, ...failures], 'Sync failed; rollback incomplete');
    throw error;
  }
}

export function loadConfig(root) {
  const config = document(root, join(root, 'odysseus.json'));
  if (
    config?.schemaVersion !== 1 ||
    !record(config.components) ||
    typeof config.sharedDirectory !== 'string'
  ) {
    throw new Error('Unsupported odysseus.json: schemaVersion must be 1');
  }
  const shared = resolve(root, config.sharedDirectory);
  safePath(root, shared);
  const state = join(root, '.odysseus');
  if (shared === root || inside(shared, state) || inside(state, shared))
    throw new Error('Shared directory must be separate from manager state');
  for (const component of Object.values(config.components)) {
    if (typeof component.source !== 'string')
      throw new Error('Each component needs a source directory');
    const source = resolve(root, component.source);
    if (inside(source, shared) || inside(shared, source))
      throw new Error('Shared profile must be outside component source/install directories');
  }
  return { config, shared };
}

export function syncProfile(
  rootPath,
  { attach, detach, importExisting = false, check = false } = {},
) {
  const root = realpathSync(rootPath);
  const { shared } = loadConfig(root);
  const stateDir = join(root, '.odysseus');
  safePath(root, stateDir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = join(stateDir, 'sync.lock');
  safePath(root, lock);
  if (existsSync(lock)) {
    const owner = document(root, join(lock, 'owner.json'), {});
    let alive = false;
    if (Number.isInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        alive = true;
      } catch (error) {
        alive = error.code === 'EPERM';
      }
    }
    // Older versions left an empty directory after a crash. Give an owner writer a grace period.
    if (
      !alive &&
      ((Number.isInteger(owner.pid) && owner.pid > 0) ||
        Date.now() - lstatSync(lock).mtimeMs > 30000)
    )
      rmSync(lock, { recursive: true });
  }
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another sync holds ${lock}.`);
    throw error;
  }
  try {
    writeFileSync(join(lock, 'owner.json'), json({ pid: process.pid }), {
      mode: 0o600,
      flag: 'wx',
    });
    const statePath = join(stateDir, 'state.json');
    const state = document(root, statePath, { schemaVersion: 1, projects: {} });
    if (state.schemaVersion !== 1 || !record(state.projects))
      throw new Error('Unsupported profile state');
    if (detach) delete state.projects[existsSync(detach) ? realpathSync(detach) : resolve(detach)];
    const attached = attach ? realpathSync(attach) : undefined;
    if (attached) {
      if (inside(stateDir, attached) || inside(attached, stateDir))
        throw new Error('Do not attach the manager state directory');
      if (inside(shared, attached) || inside(attached, shared))
        throw new Error('Attach a working project, separate from the shared catalog');
      const { config } = loadConfig(root);
      for (const component of Object.values(config.components)) {
        const source = resolve(root, component.source);
        if (inside(source, attached) || inside(attached, source))
          throw new Error('Do not attach component source/install directories');
      }
      state.projects[attached] ??= { baseline: {} };
    }
    if (importExisting && !attached) throw new Error('Import requires attach PROJECT');
    const common = inventory(shared, true);
    const projects = Object.entries(state.projects).map(([path, entry]) => {
      if (!existsSync(path)) throw new Error(`Attached project is unavailable: ${path}`);
      return { path, baseline: entry.baseline, ...inventory(path, false) };
    });
    if (importExisting) {
      const project = projects.find((entry) => entry.path === attached);
      for (const [key, value] of project.values) {
        if (value === null) throw new Error(`Import conflict between CLI/Desktop copies: ${key}`);
        const existing = common.values.get(key);
        if (existing && !existing.equals(value))
          throw new Error(`Import conflict in shared catalog: ${key}`);
        common.values.set(key, value);
      }
    }
    const keys = new Set([
      ...common.values.keys(),
      ...projects.flatMap((project) => Object.keys(project.baseline)),
    ]);
    const resolved = new Map();
    for (const key of keys) {
      if (
        !key.startsWith('mcp:') &&
        (!/^(skills|agents|rules)\//.test(key) ||
          key
            .split('/')
            .some(
              (segment) =>
                !segment || segment === '.' || segment === '..' || segment.includes('\\'),
            ))
      ) {
        throw new Error(`Invalid managed resource key: ${key}`);
      }
      const central = common.values.get(key);
      let chosen = central;
      let proposed = false;
      for (const project of projects) {
        const baseline = project.baseline[key];
        const variants = key.startsWith('mcp:')
          ? [project.values.get(key)]
          : targets(key).map((target) => read(project.path, join(project.path, target)));
        for (const local of variants) {
          if (baseline === undefined) {
            if (local !== undefined && hash(local) !== hash(central))
              throw new Error(`Existing project resource conflicts: ${project.path} / ${key}`);
            continue;
          }
          if (hash(local) === baseline) continue;
          if (hash(central) !== baseline && hash(local) !== hash(central))
            throw new Error(`Both shared and project changed: ${project.path} / ${key}`);
          if (proposed && hash(chosen) !== hash(local))
            throw new Error(`Projects disagree on shared resource: ${key}`);
          chosen = local;
          proposed = true;
        }
      }
      resolved.set(key, chosen);
    }
    const changes = [];
    const queue = (base, path, value, mode) => {
      const old = read(base, path);
      if (hash(old) !== hash(value))
        changes.push({
          path,
          value,
          ...(old === undefined && mode ? { mode } : {}),
        });
    };
    const destinations = [{ path: shared, ...common, shared: true }, ...projects];
    for (const destination of destinations) {
      const mcp = {
        ...destination.mcp,
        mcpServers: { ...destination.mcp.mcpServers },
      };
      for (const [key, value] of resolved) {
        if (key.startsWith('mcp:')) {
          if (value === undefined) delete mcp.mcpServers[key.slice(4)];
          else {
            const server = JSON.parse(value);
            // The CLI chooses Streamable HTTP by httpUrl, ignoring type.
            // Desktop chooses it by type + url. Both must see the same wire.
            if (!destination.shared && server.type === 'http') server.httpUrl = server.url;
            Object.defineProperty(mcp.mcpServers, key.slice(4), {
              value: server,
              enumerable: true,
              configurable: true,
              writable: true,
            });
          }
        } else {
          const origins = [
            join(shared, key),
            ...projects.flatMap((project) =>
              targets(key).map((target) => join(project.path, target)),
            ),
          ];
          const executable = origins.some(
            (path) =>
              existsSync(path) &&
              lstatSync(path).mode & 0o111 &&
              hash(readFileSync(path)) === hash(value),
          );
          for (const target of destination.shared ? [key] : targets(key))
            queue(
              destination.path,
              join(destination.path, target),
              value,
              executable ? 0o700 : 0o600,
            );
        }
      }
      validateMcp(mcp.mcpServers, destination.mcpPath);
      if (keys.size || existsSync(destination.mcpPath))
        queue(destination.path, destination.mcpPath, json(mcp));
    }
    for (const project of projects) {
      state.projects[project.path].baseline = Object.fromEntries(
        [...resolved]
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, hash(value)]),
      );
    }
    queue(root, statePath, json(state));
    if (!check) transaction(changes);
    return {
      projects: projects.map((project) => project.path),
      resources: [...resolved.values()].filter((value) => value !== undefined).length,
      changes: changes.map((change) => change.path),
      applied: !check,
    };
  } finally {
    rmSync(lock, { recursive: true });
  }
}
