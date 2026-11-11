// Runs as an esbuild banner BEFORE native config modules evaluate their environment.
const { join: odJoin } = require('node:path');
const odPayload = odJoin(process.resourcesPath, 'odysseus');
let odEnv;
try {
  odEnv = JSON.parse(
    require('node:child_process').execFileSync(
      odJoin(odPayload, 'node'),
      [odJoin(odPayload, 'tools/distribution/prepare.mjs'), odPayload, String(process.pid)],
      { encoding: 'utf8', timeout: 15 * 60 * 1000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } },
    ),
  );
} catch (error) {
  const detail = error.stderr?.toString().trim() || error.message;
  require('electron').dialog.showErrorBox('Odysseus: запуск остановлен', detail + '\n\nНе удаляйте ~/.odysseus. Закройте остальные сеансы Odysseus и повторите запуск. Резервные копии: ~/.odysseus/updates/backups.');
  process.exit(1);
}
Object.assign(process.env, odEnv);
process.once('exit', () => {
  try { require('node:fs').unlinkSync(odEnv.ODYSSEUS_RUN_LEASE); } catch {}
});
for (const key of Object.keys(process.env))
  if (key.startsWith('CLAUDE_CODE_') || key === 'ELECTRON_RUN_AS_NODE') delete process.env[key];
// Source launchers already own a watcher; packaged apps need their own desktop lease.
const odWatch = require('node:child_process').spawn(
  odEnv.ODYSSEUS_NODE,
  [odJoin(odEnv.ODYSSEUS_ROOT, 'tools/distribution/desktop-watch.mjs'), String(process.pid)],
  { env: { ...process.env }, stdio: 'ignore', detached: true },
);
odWatch.on('error', () => {});
odWatch.unref();
