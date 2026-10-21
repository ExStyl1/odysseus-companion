import {
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  unlinkSync,
  statSync,
  chmodSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  PersonalTransaction,
  document,
  bytes,
  privateWrite,
  digest,
  reconcile,
  contained,
  files,
  noLinks,
} from './personal/store.mjs';
import { syncModels } from './personal/models.mjs';
import { syncChats } from './personal/chats.mjs';
import { applyCliAppearance, cliColorMode } from './cli/appearance.mjs';
import { managedProfiles } from './setup/paths.mjs';
export function personalPaths(root, options = {}) {
  const home = options.home || homedir();
  const privateDir = resolve(
    options.privateDir || process.env.ODYSSEUS_DATA_DIR || join(home, '.odysseus'),
  );
  const imported = managedProfiles(privateDir);
  return {
    root: resolve(root),
    cliHome: resolve(
      options.cliHome || process.env.NESSY_HOME || imported?.cliHome || join(home, '.nessy'),
    ),
    desktopHome: resolve(
      options.desktopHome ||
        process.env.NESSY_CONFIG_DIR ||
        imported?.desktopHome ||
        join(home, '.nessy-agent'),
    ),
    privateDir,
    defaultCwd: options.defaultCwd || join(resolve(root), 'workspace'),
    cliRuntime:
      options.cliRuntime ||
      process.env.NESSY_RUNTIME_DIR ||
      options.cliHome ||
      process.env.NESSY_HOME ||
      imported?.cliRuntime ||
      join(home, '.nessy'),
  };
}
function recover(paths, check) {
  const pending = join(paths.privateDir, 'pending.json');
  if (!existsSync(pending)) return;
  if (check)
    throw Error(
      'Interrupted personal transaction needs recovery; run personal-sync without --check',
    );
  const entry = document(pending);
  if (!contained(join(paths.privateDir, 'backups'), entry.backup) || !Array.isArray(entry.journal))
    throw Error('Invalid personal recovery journal');
  for (const item of entry.journal) {
    if (
      ![paths.cliHome, paths.cliRuntime, paths.desktopHome, paths.privateDir].some((root) =>
        contained(root, item.path),
      ) ||
      !/^\d+\.bak$/.test(item.file)
    )
      throw Error('Invalid recovery path');
    const old = item.existed ? bytes(join(entry.backup, item.file)) : undefined,
      actual = bytes(item.path);
    if (digest(actual) === digest(old)) continue;
    if (digest(actual) !== item.after)
      throw Error('Personal file changed since interruption; manual recovery required');
    if (old === undefined) unlinkSync(item.path);
    else privateWrite(item.path, old);
  }
  unlinkSync(pending);
}
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
export function readDesktopLease(paths, now = Date.now()) {
  const lease = document(join(paths.privateDir, 'desktop-lease.json'));
  return alive(lease.pid) && now - lease.updatedAt < 30000 ? lease : {};
}
export function writeDesktopLease(paths, protectedSessions) {
  privateWrite(
    join(paths.privateDir, 'desktop-lease.json'),
    JSON.stringify({
      pid: process.pid,
      updatedAt: Date.now(),
      protectedSessions,
    }),
  );
}
export function syncPersonal(root, options = {}) {
  const paths = personalPaths(root, options),
    check = Boolean(options.check),
    now = options.now || Date.now();
  const report = {
    schemaVersion: 1,
    applied: !check,
    conflicts: [],
    unsupported: [],
    deferred: [],
    updatedChats: [],
    changes: [],
    bindings: [],
  };
  if (!existsSync(paths.cliHome) || !existsSync(paths.desktopHome)) {
    report.deferred.push('native-profiles-not-created');
    return report;
  }
  noLinks(paths.privateDir);
  const lock = join(paths.privateDir, 'sync.lock');
  mkdirSync(paths.privateDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.privateDir, 0o700);
  if (existsSync(lock)) {
    const owner = document(join(lock, 'owner.json'));
    if (
      !alive(owner.pid) &&
      ((Number.isInteger(owner.pid) && owner.pid > 0) ||
        Date.now() - statSync(lock).mtimeMs > 30000)
    )
      rmSync(lock, { recursive: true });
  }
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (e) {
    if (e.code === 'EEXIST') throw Error('Personal sync already running');
    throw e;
  }
  try {
    privateWrite(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    recover(paths, check);
    const tx = new PersonalTransaction(paths.privateDir, check),
      statePath = join(paths.privateDir, 'state.json');
    const state = tx.json(statePath, {
      schemaVersion: 1,
      fields: {},
      connections: {},
      chats: {},
    });
    if (state.schemaVersion !== 1) throw Error('Unsupported personal sync state');
    const cliPath = join(paths.cliHome, 'settings.json'),
      deskPath = join(paths.desktopHome, 'config.json'),
      prefsPath = join(paths.desktopHome, 'preferences.json');
    const cli = tx.json(cliPath),
      desktop = tx.json(deskPath),
      prefs = tx.json(prefsPath);
    const language = reconcile(
      state,
      'ui-language',
      cli.general?.language === 'auto' ? undefined : cli.general?.language,
      prefs.uiLanguage,
      report,
    );
    if (!language.conflict && language.value !== undefined) {
      if (['en', 'ru', 'zh-CN'].includes(language.value)) {
        cli.general = { ...cli.general, language: language.value };
        prefs.uiLanguage = language.value;
        language.accept();
      } else report.unsupported.push('ui-language-not-supported-by-both');
    } else if (!language.conflict) language.accept();
    const cliMode = cliColorMode(cli.ui?.theme);
    const keepCustomTheme =
      state.cliAppearanceVersion === 1 && Boolean(cli.ui?.theme) && cliMode === undefined;
    const appearance = reconcile(state, 'appearance', cliMode, prefs.odysseusColorScheme, report);
    if (!appearance.conflict && appearance.value !== undefined) {
      if (['light', 'dark', 'system'].includes(appearance.value)) {
        // CLI has two named default palettes and no equivalent to system mode.
        if (appearance.value !== 'system') {
          if (!keepCustomTheme)
            cli.ui = {
              ...cli.ui,
              theme: appearance.value === 'dark' ? 'Odysseus Dark' : 'Odysseus Light',
            };
          prefs.odysseusColorScheme = appearance.value;
          appearance.accept(keepCustomTheme ? undefined : appearance.value, appearance.value);
        } else {
          prefs.odysseusColorScheme = 'system';
          appearance.accept(cliMode, 'system');
        }
      } else report.unsupported.push('appearance-not-portable');
    } else if (!appearance.conflict) {
      if (keepCustomTheme) appearance.accept(undefined, prefs.odysseusColorScheme);
      else appearance.accept();
    }
    const themeChanged = applyCliAppearance(cli, prefs, {
      migrate: state.cliAppearanceVersion !== 1,
      changeTheme: !appearance.conflict,
    });
    if (themeChanged && !appearance.conflict) {
      const mode = cliColorMode(cli.ui.theme);
      if (prefs.odysseusColorScheme === undefined) prefs.odysseusColorScheme = mode;
      state.fields.appearance = {
        value: prefs.odysseusColorScheme,
        cli: mode,
        desktop: prefs.odysseusColorScheme,
      };
    }
    state.cliAppearanceVersion = 1;
    report.bindings = syncModels(cli, desktop, state, report);
    const lease = readDesktopLease(paths, now);
    const protectedCli = [];
    for (const file of files(join(paths.cliRuntime, 'projects'), '.runtime.json')) {
      const status = tx.json(file),
        sessionId = status.session_id ?? status.sessionId;
      if (alive(status.pid) && typeof sessionId === 'string') protectedCli.push(sessionId);
    }
    syncChats({
      ...paths,
      tx,
      state,
      report,
      now,
      settleMs: options.settleMs ?? 2000,
      protectedDesktop: options.protectedDesktop || lease.protectedSessions || [],
      protectedCli: [...protectedCli, ...(options.protectedCli || [])],
    });
    tx.putJson(cliPath, cli);
    tx.putJson(deskPath, desktop);
    tx.putJson(prefsPath, prefs);
    tx.putJson(statePath, state);
    report.changes = tx.commit();
    report.unsupported = [...new Set(report.unsupported)];
    report.deferred = [...new Set(report.deferred)];
    if (!check)
      privateWrite(
        join(paths.privateDir, 'status.json'),
        JSON.stringify(
          {
            ...report,
            bindings: report.bindings.map(({ envKeys, ...b }) => b),
            updatedAt: now,
          },
          null,
          2,
        ),
      );
    return report;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
function printReport(report) {
  console.log(
    JSON.stringify(
      {
        applied: report.applied,
        changedFiles: report.changes.length,
        updatedChats: report.updatedChats.length,
        conflicts: report.conflicts,
        unsupported: report.unsupported,
        deferred: report.deferred,
      },
      null,
      2,
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2),
    root = argv[0];
  if (!root) throw Error('Expected Odysseus root');
  try {
    printReport(syncPersonal(root, { check: argv.includes('--check') }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
