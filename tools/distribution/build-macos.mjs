#!/usr/bin/env node
/** Reproducible local packaging: no credential synchronization, publishing or source-profile inclusion. */
import { resolve, join, dirname } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '../..'),
  args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  console.log(
    'npm run build:mac [-- --skip-build] [--signed]\nBuilds a self-contained Odysseus.app and DMG for the current Mac architecture. --signed requires CSC_NAME and Apple notarization credentials.',
  );
  process.exit(0);
}
if (process.platform !== 'darwin') throw Error('Build on macOS');
const config = JSON.parse(readFileSync(join(root, 'odysseus.json'))),
  desktop = join(root, config.components.desktop.source),
  cli = join(root, config.components.cli.source),
  electron = join(desktop, 'apps/electron');
const require = createRequire(join(desktop, 'package.json')),
  { build, Platform, Arch } = require('electron-builder');
const output = join(root, 'dist'),
  stage = join(root, '.odysseus/distribution-stage'),
  app = join(stage, 'app'),
  payload = join(stage, 'payload');
const bun = process.env.ODYSSEUS_BUN || join(root, '.odysseus/runtime/bun');
const env = { ...process.env, PATH: dirname(bun) + ':' + process.env.PATH };
function run(command, argv, cwd) {
  console.log(
    '→ ' +
      command +
      ' ' +
      (argv[0] === 'notarytool' ? 'notarytool submit [credentials omitted]' : argv.join(' ')),
  );
  const result = spawnSync(command, argv, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Error(
      'Build step failed: ' + (argv[0] === 'notarytool' ? 'notarytool submit' : argv.join(' ')),
    );
}
if (args.has('--signed') && !env.CSC_NAME) throw Error('Set CSC_NAME for a signed release');
if (
  args.has('--signed') &&
  !(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) &&
  !(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
)
  throw Error('Set Apple notarization credentials for a signed release');
if (!existsSync(bun)) throw Error('Install Bun or set ODYSSEUS_BUN');
if (!args.has('--skip-build')) {
  run(process.execPath, [join(root, 'tools/install-desktop-bridge.mjs')], root);
  run(process.execPath, ['scripts/build.js', '--cli-only', '--web-shell'], cli);
  run(process.execPath, ['esbuild.config.js'], cli);
  run(process.execPath, ['scripts/copy_bundle_assets.js'], cli);
  run(bun, ['run', 'electron:build'], desktop);
}
rmSync(stage, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
mkdirSync(payload, { recursive: true });
mkdirSync(output, { recursive: true });
function copy(source, target) {
  if (!existsSync(source)) throw Error('Missing release input: ' + source);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, dereference: true });
}
copy(join(electron, 'dist'), join(app, 'dist'));
copy(join(electron, 'resources/pi-agent-server'), join(app, 'resources/pi-agent-server'));
if (existsSync(join(electron, 'resources/session-mcp-server')))
  copy(join(electron, 'resources/session-mcp-server'), join(app, 'resources/session-mcp-server'));
copy(join(electron, 'resources/bin'), join(app, 'resources/bin'));
copy(join(electron, 'resources/scripts'), join(app, 'resources/scripts'));
copy(join(desktop, 'packages/shared/src'), join(app, 'packages/shared/src'));
const native = JSON.parse(readFileSync(join(electron, 'package.json')));
writeFileSync(
  join(app, 'package.json'),
  JSON.stringify({
    name: 'odysseus-desktop',
    productName: 'Odysseus',
    version: native.version,
    description: 'Odysseus Desktop and CLI',
    author: 'Odysseus',
    main: 'dist/main.cjs',
  }),
);
const main = join(app, 'dist/main.cjs');
copy(join(root, 'tools/distribution/bootstrap.cjs'), join(app, 'dist/odysseus-bootstrap.cjs'));
writeFileSync(
  main,
  '"use strict";\nrequire(\'./odysseus-bootstrap.cjs\');\n' + readFileSync(main, 'utf8'),
);
for (const name of ['tools', 'integrations', 'shared', 'docs'])
  copy(join(root, name), join(payload, name));
copy(process.execPath, join(payload, 'node'));
chmodSync(join(payload, 'node'), 0o755);
copy(bun, join(payload, 'bun'));
chmodSync(join(payload, 'bun'), 0o755);
copy(join(cli, 'dist'), join(payload, 'cli/dist'));
writeFileSync(join(payload, 'cli/package.json'), JSON.stringify({ type: 'module' }));
// Only native optional packages remain external in the official CLI bundle.
const packages = [
  '@lydell/node-pty',
  `@lydell/node-pty-darwin-${process.arch}`,
  '@teddyzhu/clipboard',
  `@teddyzhu/clipboard-darwin-${process.arch}`,
  '@nestor/nessy-cli-audio-capture',
  'node-gyp-build',
];
for (const name of packages)
  copy(join(cli, 'node_modules', name), join(payload, 'cli/node_modules', name));
writeFileSync(
  join(payload, 'odysseus.json'),
  JSON.stringify({
    schemaVersion: 1,
    sharedDirectory: 'shared',
    components: {
      cli: { source: 'cli', bundled: true, command: ['od'] },
      desktop: { source: 'desktop', command: ['open', '-a', 'Odysseus'] },
    },
  }),
);
writeFileSync(
  join(payload, 'release.json'),
  JSON.stringify({
    version: native.version,
    buildId: randomUUID(),
    arch: process.arch,
    builtAt: new Date().toISOString(),
  }),
);
// Archive inspection is data-only and must remain available after installing outside the source checkout.
const asarRequire = createRequire(join(desktop, 'node_modules/@electron/asar/package.json'));
const seen = new Set();
function dependency(name, from = asarRequire) {
  let source = dirname(from.resolve(name));
  while (
    !existsSync(join(source, 'package.json')) ||
    JSON.parse(readFileSync(join(source, 'package.json'))).name !== name
  ) {
    const parent = dirname(source);
    if (parent === source) throw Error('Cannot locate package ' + name);
    source = parent;
  }
  const packageFile = join(source, 'package.json');
  const metadata = JSON.parse(readFileSync(packageFile));
  if (seen.has(metadata.name)) return;
  seen.add(metadata.name);
  copy(source, join(payload, 'desktop/node_modules', metadata.name));
  const local = createRequire(packageFile);
  for (const dep of Object.keys(metadata.dependencies || {})) dependency(dep, local);
}
dependency('@electron/asar', require);
copy(
  join(electron, `resources/bin/darwin-${process.arch}/uv`),
  join(payload, `desktop/apps/electron/resources/bin/darwin-${process.arch}/uv`),
);
const extraResources = [
  { from: payload, to: 'odysseus' },
  { from: bun, to: 'vendor/bun/bun' },
  { from: join(electron, 'resources/bin/node'), to: 'bin/node' },
  {
    from: join(desktop, 'node_modules/@anthropic-ai/claude-agent-sdk'),
    to: 'app/node_modules/@anthropic-ai/claude-agent-sdk',
  },
  {
    from: join(desktop, `node_modules/@anthropic-ai/claude-agent-sdk-darwin-${process.arch}`),
    to: 'app/node_modules/@anthropic-ai/claude-agent-sdk-binary',
  },
  { from: join(desktop, 'node_modules/@vscode/ripgrep'), to: 'app/node_modules/@vscode/ripgrep' },
  {
    from: join(desktop, `node_modules/@vscode/ripgrep-darwin-${process.arch}`),
    to: `app/node_modules/@vscode/ripgrep-darwin-${process.arch}`,
  },
];
for (const entry of extraResources)
  if (!existsSync(entry.from)) throw Error('Missing release resource: ' + entry.from);
const builderConfig = {
  appId: 'app.odysseus.desktop',
  productName: 'Odysseus',
  directories: { app, output, buildResources: join(electron, 'resources') },
  electronVersion: '39.2.7',
  electronDist: join(desktop, 'node_modules/electron/dist'),
  asar: false,
  npmRebuild: false,
  files: [
    { from: 'dist', to: 'dist', filter: ['**/*', '!**/*.map'] },
    { from: 'resources', to: 'resources', filter: ['**/*'] },
    { from: 'packages', to: 'packages', filter: ['**/*'] },
    'package.json',
  ],
  extraResources,
  afterPack: async (context) => {
    await require(join(electron, 'scripts/ensure-claude-sdk-binary-dir.cjs'))(context);
    const contents = join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      'Contents',
    );
    copy(join(electron, 'resources/icon.icns'), join(contents, 'Resources/odysseus.icns'));
    run(
      '/usr/bin/plutil',
      ['-replace', 'CFBundleIconFile', '-string', 'odysseus.icns', join(contents, 'Info.plist')],
      root,
    );
  },
  protocols: [{ name: 'Odysseus', schemes: ['nessy', 'odysseus'] }],
  publish: null,
  mac: {
    category: 'public.app-category.productivity',
    icon: join(electron, 'resources/icon.icns'),
    identity: args.has('--signed') ? env.CSC_NAME : null,
    hardenedRuntime: args.has('--signed'),
    notarize: args.has('--signed'),
    entitlements: join(electron, 'build/entitlements.mac.plist'),
    entitlementsInherit: join(electron, 'build/entitlements.mac.plist'),
    signIgnore: ['resources/bin/codex/'],
    artifactName: 'Odysseus-${version}-${arch}.${ext}',
    extendInfo: {
      NSAppleEventsUsageDescription:
        'Odysseus opens Terminal to run od and continue your selected chat.',
      NSLocalNetworkUsageDescription:
        'Odysseus connects to your local models and configured services.',
    },
  },
  dmg: {
    title: 'Odysseus',
    artifactName: 'Odysseus-${version}-${arch}.${ext}',
    icon: join(electron, 'resources/icon.icns'),
    contents: [
      { x: 140, y: 180 },
      { x: 420, y: 180, type: 'link', path: '/Applications' },
    ],
    window: { width: 560, height: 360 },
  },
};
if (!args.has('--signed')) env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
Object.assign(process.env, env);
const artifacts = await build({
  targets: Platform.MAC.createTarget(['dir'], process.arch === 'arm64' ? Arch.arm64 : Arch.x64),
  config: builderConfig,
});
const image = join(stage, 'image');
mkdirSync(image, { recursive: true });
copy(
  join(output, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Odysseus.app'),
  join(image, 'Odysseus.app'),
);
symlinkSync('/Applications', join(image, 'Applications'));
writeFileSync(
  join(image, 'Установка.txt'),
  'Перетащите Odysseus.app в Applications и откройте приложение.\nКоманда od будет доступна в новом окне терминала после первого открытия.\n',
);
const dmg = join(output, `Odysseus-${native.version}-${process.arch}.dmg`);
run(
  '/usr/bin/hdiutil',
  [
    'create',
    '-ov',
    '-fs',
    'HFS+',
    '-format',
    'UDZO',
    '-volname',
    'Odysseus',
    '-srcfolder',
    image,
    dmg,
  ],
  root,
);
if (args.has('--signed')) {
  run('/usr/bin/codesign', ['--sign', env.CSC_NAME, '--timestamp', dmg], root);
  const auth = env.APPLE_API_KEY
    ? [
        '--key',
        env.APPLE_API_KEY,
        '--key-id',
        env.APPLE_API_KEY_ID,
        '--issuer',
        env.APPLE_API_ISSUER,
      ]
    : [
        '--apple-id',
        env.APPLE_ID,
        '--password',
        env.APPLE_APP_SPECIFIC_PASSWORD,
        '--team-id',
        env.APPLE_TEAM_ID,
      ];
  run('/usr/bin/xcrun', ['notarytool', 'submit', dmg, '--wait', ...auth], root);
  run('/usr/bin/xcrun', ['stapler', 'staple', dmg], root);
}
for (const file of [dmg]) {
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  writeFileSync(file + '.sha256', digest + '  ' + file.split('/').at(-1) + '\n');
  console.log('Ready: ' + file);
}
