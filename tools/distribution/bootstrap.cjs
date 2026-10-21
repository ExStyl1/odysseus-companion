// Runs as an esbuild banner BEFORE native config modules evaluate their environment.
const { join: odJoin } = require('node:path');
const odPayload = odJoin(process.resourcesPath, 'odysseus');
const odEnv = JSON.parse(
  require('node:child_process').execFileSync(
    odJoin(odPayload, 'node'),
    [odJoin(odPayload, 'tools/distribution/prepare.mjs'), odPayload],
    { encoding: 'utf8', timeout: 120000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } },
  ),
);
Object.assign(process.env, odEnv);
for (const key of Object.keys(process.env))
  if (key.startsWith('CLAUDE_CODE_') || key === 'ELECTRON_RUN_AS_NODE') delete process.env[key];
