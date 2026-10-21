import * as fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const forbidden = /qwen/gi;
const decoder = new TextDecoder('utf-8', { fatal: true });
const ignored = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const opaqueAsset =
  /\.(?:png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|heic|pdf|mp4|webm|car)$/i;
const remoteImage =
  /!\[[^\]\n]*\]\(https?:\/\/[^\s)]+(?:\s+"[^"]*")?\)|<(?:img|video|source)\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^>]+>/g;

export function loadConfig(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (const key of [
    'replace',
    'preserve',
    'patches',
    'assets',
    'remoteImages',
    'replaceBeforePreserve',
  ]) {
    if (typeof config[key] !== 'string') continue;
    const file = path.resolve(path.dirname(configPath), config[key]);
    const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(rules))
      throw new Error(`Config field ${key} requires an array in ${file}`);
    config[key] = rules;
  }
  for (const patch of config.patches ?? []) {
    if (patch.toFile === undefined) continue;
    if (
      typeof patch.toFile !== 'string' ||
      !patch.toFile ||
      patch.to !== undefined
    )
      throw new Error(`Patch needs either to or toFile: ${patch.path}`);
    const configDir = fs.realpathSync(path.dirname(configPath));
    const file = fs.realpathSync(path.resolve(configDir, patch.toFile));
    const relative = path.relative(configDir, file);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(
        `Patch fragment escapes config directory: ${patch.toFile}`,
      );
    patch.to = fs.readFileSync(file, 'utf8');
    delete patch.toFile;
  }
  return config;
}

function filesIn(root, prefix = '') {
  return fs
    .readdirSync(path.join(root, prefix), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap((entry) => {
      if (ignored.has(entry.name)) return [];
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? filesIn(root, name) : [name];
    });
}

function sourceFiles(root, transform) {
  let tracked;
  try {
    tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    return filesIn(root);
  }
  // Renamed .qwen files may now live under an ignored .nessy directory.
  // Include both forms, but never untracked build output or local credentials.
  return [...new Set(tracked.flatMap((name) => [name, transform(name, name)]))]
    .filter((name) => {
      try {
        return !fs.lstatSync(path.join(root, name)).isDirectory();
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    })
    .sort();
}

const mentionKey = ({ file, scope, text }) =>
  JSON.stringify([file, scope, text]);

function remainingMentions(entries, rules) {
  const found = new Map();
  for (const entry of entries) {
    const values = [['path', entry.target]];
    try {
      if (!entry.binary && !entry.after.includes(0))
        values.push([
          entry.symlink ? 'symlink' : 'content',
          decoder.decode(entry.after),
        ]);
    } catch {
      /* Opaque binary contents do not participate in the text audit. */
    }
    for (const [scope, value] of values) {
      if (!/qwen/i.test(value)) continue;
      const spans = rules.flatMap((rule) => {
        if (!rule.paths.test(entry.name)) return [];
        rule.regex.lastIndex = 0;
        return [...value.matchAll(rule.regex)].map((match) => ({
          start: match.index,
          end: match.index + match[0].length,
          id: rule.id,
        }));
      });
      let offset = 0;
      for (const [index, line] of value.split('\n').entries()) {
        const matches = [...line.matchAll(/qwen/gi)];
        if (matches.length) {
          const covering = new Set();
          for (const match of matches)
            for (const span of spans)
              if (
                span.start <= offset + match.index &&
                span.end >= offset + match.index + match[0].length
              )
                covering.add(span.id);
          const item = {
            file: entry.target,
            scope,
            text: line.trim(),
            rules: [...covering].sort(),
          };
          const key = mentionKey(item);
          const row = found.get(key) ?? { ...item, count: 0, lines: [] };
          row.rules = [...new Set([...row.rules, ...item.rules])].sort();
          row.count += matches.length;
          row.lines.push(index + 1);
          found.set(key, row);
        }
        offset += line.length + 1;
      }
    }
  }
  return [...found.values()];
}

function compareMentions(current, baseline) {
  const known = new Map();
  for (const row of baseline.entries) {
    if (
      !row ||
      typeof row.file !== 'string' ||
      !['content', 'path', 'symlink'].includes(row.scope) ||
      typeof row.text !== 'string' ||
      !/qwen/i.test(row.text) ||
      !Number.isSafeInteger(row.count) ||
      row.count < 1
    )
      throw new Error('Invalid mention baseline entry');
    const key = mentionKey(row);
    if (known.has(key)) throw new Error('Duplicate mention baseline entry');
    known.set(key, row);
  }
  const added = [];
  const removed = [];
  for (const row of current) {
    const key = mentionKey(row);
    const expected = known.get(key)?.count ?? 0;
    if (row.count > expected)
      added.push({ ...row, expected, extra: row.count - expected });
    if (row.count < expected)
      removed.push({ ...row, expected, missing: expected - row.count });
    known.delete(key);
  }
  for (const row of known.values())
    removed.push({ ...row, expected: row.count, missing: row.count, count: 0 });
  return { added, removed };
}

export function plan(
  root,
  config,
  configDir = path.dirname(fileURLToPath(import.meta.url)),
) {
  root = fs.realpathSync(root);
  const baseline = config.mentionsBaseline
    ? JSON.parse(
        fs.readFileSync(
          path.resolve(configDir, config.mentionsBaseline),
          'utf8',
        ),
      )
    : null;
  if (
    config.mentionsBaseline &&
    (!baseline || !Array.isArray(baseline.entries))
  )
    throw new Error('Mention baseline must contain an entries array');
  const replacements = [...config.replace].sort(
    (a, b) => b.from.length - a.from.length,
  );
  const replacementMap = new Map(
    replacements.map(({ from, to }) => [from, to]),
  );
  const replacePattern = new RegExp(
    replacements.map(({ from }) => escape(from)).join('|'),
    'g',
  );
  const rules = config.preserve.map((rule) => {
    if (!rule.pattern) throw new Error('Every exception needs a pattern');
    return {
      ...rule,
      regex: new RegExp(rule.pattern, rule.flags ?? 'g'),
      paths: new RegExp(rule.paths ?? '.*'),
    };
  });
  const report = {
    configHash: hash(
      JSON.stringify(config) + (baseline ? JSON.stringify(baseline) : ''),
    ),
    files: 0,
    changed: [],
    allowed: {},
    unexpected: [],
    binary: [],
    assets: [],
    remoteImages: [],
  };
  const transform = (text, name, audit = false) => {
    if (!audit) {
      for (const rule of config.replaceBeforePreserve ?? []) {
        if (new RegExp(rule.paths ?? '.*').test(name))
          text = text.replaceAll(rule.from, rule.to);
      }
    }
    const spans = [];
    for (const rule of rules) {
      if (!rule.paths.test(name)) continue;
      rule.regex.lastIndex = 0;
      for (const match of text.matchAll(rule.regex)) {
        if (!match[0]) throw new Error(`Empty exception match: ${rule.id}`);
        spans.push([match.index, match.index + match[0].length]);
        if (audit && /qwen/i.test(match[0])) {
          const item = (report.allowed[rule.id] ??= {
            count: 0,
            examples: [],
          });
          item.count++;
          if (item.examples.length < 3)
            item.examples.push({ file: name, text: match[0].slice(0, 180) });
        }
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    let output = '';
    const part = (start, end) => {
      const input = text.slice(start, end);
      const result = audit
        ? input
        : input.replace(replacePattern, (match) => replacementMap.get(match));
      if (audit)
        for (const match of result.matchAll(forbidden)) {
          report.unexpected.push({
            file: name,
            line: text.slice(0, start + match.index).split('\n').length,
            text: result.slice(Math.max(0, match.index - 30), match.index + 80),
          });
        }
      return result;
    };
    for (const [start, end] of spans) {
      if (end <= cursor) continue;
      output +=
        part(cursor, Math.max(cursor, start)) +
        text.slice(Math.max(cursor, start), end);
      cursor = end;
    }
    return output + part(cursor, text.length);
  };
  const entries = [];
  const destinations = new Map();
  const seenPatches = new Set();
  const seenRemoteImages = new Set();
  const seenAssets = new Set();
  const assets = new Map();
  for (const asset of config.assets ?? []) {
    if (!asset.replaceWith || !/^[a-f0-9]{64}$/.test(asset.sha256))
      throw new Error(`Asset needs a replacement and SHA256: ${asset.path}`);
    for (const name of new Set([
      asset.path,
      transform(asset.path, asset.path),
    ])) {
      if (assets.has(name)) throw new Error(`Duplicate asset: ${name}`);
      assets.set(name, asset);
    }
  }
  for (const name of sourceFiles(root, transform)) {
    const source = path.join(root, name);
    const stat = fs.lstatSync(source);
    const target = transform(name, name);
    if (
      path.isAbsolute(target) ||
      target.split('/').some((part) => part === '..' || part === '.git')
    )
      throw new Error(`Unsafe destination: ${target}`);
    const collision = destinations.get(target.toLowerCase());
    if (collision)
      throw new Error(`Path collision: ${collision} and ${name} -> ${target}`);
    destinations.set(target.toLowerCase(), name);
    const symlink = stat.isSymbolicLink();
    const before = symlink
      ? Buffer.from(fs.readlinkSync(source))
      : fs.readFileSync(source);
    let after = before;
    const asset = assets.get(name);
    if (asset) {
      seenAssets.add(asset.path);
      if (symlink) throw new Error(`Asset must be a regular file: ${name}`);
      const replacement = path.resolve(configDir, asset.replaceWith);
      const relative = path.relative(
        fs.realpathSync(configDir),
        fs.realpathSync(replacement),
      );
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error(
          `Asset replacement escapes config directory: ${asset.replaceWith}`,
        );
      after = fs.readFileSync(replacement);
      if (hash(before) !== asset.sha256 && !before.equals(after))
        throw new Error(`Asset drift: ${name}`);
      report.assets.push({
        from: name,
        to: target,
        action: 'replace',
        sha256: hash(after),
      });
    }
    let text;
    try {
      if ((symlink || !opaqueAsset.test(name)) && !after.includes(0))
        text = decoder.decode(after);
    } catch {
      /* Binary asset. */
    }
    if (text === undefined) report.binary.push(target);
    else {
      const remoteRules = (config.remoteImages ?? []).filter(
        (rule) => rule.path === name || rule.path === target,
      );
      if (config.remoteImages && /\.(?:md|html|[jt]sx)$/.test(name)) {
        for (const match of text.matchAll(remoteImage)) {
          if (
            !remoteRules.some((rule) =>
              [rule.from, rule.to].some(
                (value) =>
                  value.includes(match[0]) ||
                  transform(value, name).includes(match[0]),
              ),
            )
          )
            throw new Error(`Unclassified remote image: ${name}: ${match[0]}`);
        }
      }
      for (const rule of remoteRules) {
        if (!rule.to)
          throw new Error(
            `Remote image needs a replacement/keep value: ${name}`,
          );
        seenRemoteImages.add(rule);
        const original = text.includes(rule.from)
          ? rule.from
          : transform(rule.from, name);
        const expected = rule.count ?? 1;
        const fromCount = text.split(original).length - 1;
        const toCount = text.split(rule.to).length - 1;
        if (original === rule.to) {
          if (fromCount !== expected)
            throw new Error(`Remote image drift: ${name}`);
        } else if (fromCount === expected && toCount === 0) {
          text = text.replaceAll(original, rule.to);
        } else if (fromCount !== 0 || toCount !== expected) {
          throw new Error(`Remote image drift: ${name}`);
        }
        report.remoteImages.push({
          file: target,
          action: rule.from === rule.to ? 'keep' : 'replace',
        });
      }
      for (const patch of config.patches ?? []) {
        if (
          ![name, target].includes(patch.path) &&
          ![name, target].includes(transform(patch.path, patch.path))
        )
          continue;
        seenPatches.add(patch.path);
        if (!patch.from || !patch.to)
          throw new Error(`Patch needs non-empty markers: ${name}`);
        const finalText = transform(patch.to, name);
        // A shortened replacement can already occur inside the original block.
        // Count the longer marker first so that this overlap is not an applied patch.
        const shortens =
          patch.from !== finalText && patch.from.includes(finalText);
        const appliedCount =
          (shortens ? text.replaceAll(patch.from, '') : text).split(finalText)
            .length - 1;
        const count =
          (shortens ? text : text.replaceAll(finalText, '')).split(patch.from)
            .length - 1;
        if (count === 0 && appliedCount === patch.count) continue;
        if (appliedCount !== 0)
          throw new Error(`Partially applied patch: ${name}`);
        if (count !== patch.count)
          throw new Error(
            `Patch drift in ${name}: expected ${patch.count}, found ${count}`,
          );
        text = text.replaceAll(patch.from, patch.to);
      }
      if (!asset) text = transform(text, name);
      transform(text, name, true);
      after = Buffer.from(text);
    }
    transform(target, name, true);
    entries.push({
      name,
      target,
      before,
      after,
      mode: stat.mode,
      symlink,
      binary: text === undefined,
    });
  }
  for (const patch of config.patches ?? []) {
    if (!seenPatches.has(patch.path))
      throw new Error(`Missing patch target: ${patch.path}`);
  }
  for (const asset of config.assets ?? []) {
    if (!seenAssets.has(asset.path))
      throw new Error(`Missing asset: ${asset.path}`);
  }
  for (const rule of config.remoteImages ?? []) {
    if (!seenRemoteImages.has(rule))
      throw new Error(`Missing remote image target: ${rule.path}`);
  }
  for (const entry of entries) {
    let parent = path.posix.dirname(entry.target);
    while (parent !== '.') {
      if (destinations.has(parent.toLowerCase()))
        throw new Error(`File/directory collision: ${parent}`);
      parent = path.posix.dirname(parent);
    }
    if (
      entry.symlink &&
      (path.isAbsolute(entry.after.toString()) ||
        path
          .relative(
            root,
            path.resolve(
              root,
              path.dirname(entry.target),
              entry.after.toString(),
            ),
          )
          .startsWith('..'))
    ) {
      throw new Error(`Symlink escapes source tree: ${entry.name}`);
    }
  }
  // pnpm pins the raw bytes of its hook in the frozen lockfile.
  const hook = entries.find((entry) => entry.target === '.pnpmfile.mjs');
  const lock = entries.find((entry) => entry.target === 'pnpm-lock.yaml');
  if (hook && lock) {
    const checksum = createHash('sha256').update(hook.after).digest('base64');
    lock.after = Buffer.from(
      lock.after
        .toString()
        .replace(
          /^pnpmfileChecksum: sha256-.*$/m,
          `pnpmfileChecksum: sha256-${checksum}`,
        ),
    );
  }
  report.files = entries.length;
  const changes = entries.filter(
    (entry) => entry.name !== entry.target || !entry.before.equals(entry.after),
  );
  report.changed = changes.map(({ name, target }) => ({
    from: name,
    to: target,
  }));
  const current = remainingMentions(entries, rules);
  report.mentions = {
    baseline: config.mentionsBaseline ?? null,
    current,
    ...(baseline
      ? compareMentions(current, baseline)
      : { added: [], removed: [] }),
  };
  for (const row of report.mentions.added)
    report.unexpected.push({
      kind: 'new-remaining-mention',
      file: row.file,
      line: row.lines[0],
      text: row.text,
      rules: row.rules,
      expected: row.expected,
      actual: row.count,
    });
  return { root, entries, changes, report };
}

export function apply(result) {
  if (result.report.unexpected.length)
    throw new Error(
      'Unclassified brand spelling or new remaining mention; inspect the report\n' +
        result.report.unexpected
          .slice(0, 10)
          .map(
            (item) => `${item.file}:${item.line}: ${item.text.slice(0, 200)}`,
          )
          .join('\n'),
    );
  for (const entry of result.changes) {
    const current = path.join(result.root, entry.name);
    const bytes = entry.symlink
      ? Buffer.from(fs.readlinkSync(current))
      : fs.readFileSync(current);
    if (!bytes.equals(entry.before))
      throw new Error(`Source changed after planning: ${entry.name}`);
  }
  for (const entry of result.changes)
    fs.unlinkSync(path.join(result.root, entry.name));
  for (const entry of result.changes) {
    const target = path.join(result.root, entry.target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (entry.symlink) fs.symlinkSync(entry.after.toString(), target);
    else fs.writeFileSync(target, entry.after, { mode: entry.mode });
  }
  const parents = new Set();
  for (const entry of result.changes) {
    if (entry.name === entry.target) continue;
    let parent = path.posix.dirname(entry.name);
    while (parent !== '.') {
      parents.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  for (const parent of [...parents].sort((a, b) => b.length - a.length)) {
    const absolute = path.join(result.root, parent);
    if (fs.existsSync(absolute) && fs.readdirSync(absolute).length === 0)
      fs.rmdirSync(absolute);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        root: { type: 'string' },
        config: {
          type: 'string',
          default: fileURLToPath(new URL('./nessy.json', import.meta.url)),
        },
        mode: { type: 'string', default: 'plan' },
        report: { type: 'string' },
      },
    });
    if (!values.root || !['plan', 'apply', 'check'].includes(values.mode))
      throw new Error(
        'Usage: node rebrand.mjs --root DIR --mode plan|apply|check [--config FILE] [--report FILE]',
      );
    const config = loadConfig(values.config);
    const result = plan(
      values.root,
      config,
      path.dirname(path.resolve(values.config)),
    );
    result.report.sourceCommit = execFileSync(
      'git',
      ['-C', values.root, 'rev-parse', 'HEAD'],
      { encoding: 'utf8' },
    ).trim();
    if (values.report)
      fs.writeFileSync(
        values.report,
        `${JSON.stringify(result.report, null, 2)}\n`,
      );
    console.log(
      JSON.stringify(
        {
          files: result.report.files,
          changed: result.changes.length,
          unexpected: result.report.unexpected.length,
          newMentions: result.report.mentions.added.reduce(
            (sum, row) => sum + row.extra,
            0,
          ),
          removedMentions: result.report.mentions.removed.reduce(
            (sum, row) => sum + row.missing,
            0,
          ),
          binary: result.report.binary.length,
          assets: result.report.assets.length,
        },
        null,
        2,
      ),
    );
    if (values.mode !== 'apply')
      for (const item of result.report.unexpected.slice(0, 10))
        console.error(`${item.file}:${item.line}: ${item.text.slice(0, 200)}`);
    if (values.mode === 'apply') apply(result);
    if (
      result.report.unexpected.length ||
      (values.mode === 'check' && result.changes.length)
    )
      process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
