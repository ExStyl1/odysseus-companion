import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const UTILS_DIR = (() => {
  const workspacePath = path.join(process.cwd(), 'src', 'utils');
  if (existsSync(path.join(workspacePath, 'sandbox.ts'))) {
    return workspacePath;
  }

  return path.join(process.cwd(), 'packages', 'cli', 'src', 'utils');
})();
const MODEL_SEATBELT_PROFILES = [
  'external-model-open',
  'internal-model-open',
] as const;

function getBuiltinSeatbeltProfiles(): string[] {
  const source = readFileSync(path.join(UTILS_DIR, 'sandbox.ts'), 'utf8');
  const match = source.match(
    /const BUILTIN_SEATBELT_PROFILES = \[([\s\S]*?)];/,
  );

  expect(match).not.toBeNull();

  const profiles = [...match![1].matchAll(/'([^']+)'/g)].map(
    ([, profile]) => profile,
  );

  for (const profile of MODEL_SEATBELT_PROFILES) {
    expect(profiles).toContain(profile);
  }

  return profiles;
}

function createSeatbeltParamArgs(root: string): string[] {
  const paths = {
    target: path.join(root, 'target'),
    tmp: path.join(root, 'tmp'),
    cache: path.join(root, 'cache'),
    home: path.join(root, 'home'),
    nessy: path.join(root, 'nessy'),
    runtime: path.join(root, 'runtime'),
  };

  for (const dir of Object.values(paths)) {
    mkdirSync(dir, { recursive: true });
  }

  const realPaths = {
    target: realpathSync(paths.target),
    tmp: realpathSync(paths.tmp),
    cache: realpathSync(paths.cache),
    home: realpathSync(paths.home),
    nessy: realpathSync(paths.nessy),
    runtime: realpathSync(paths.runtime),
  };

  return [
    '-D',
    `TARGET_DIR=${realPaths.target}`,
    '-D',
    `TMP_DIR=${realPaths.tmp}`,
    '-D',
    `HOME_DIR=${realPaths.home}`,
    '-D',
    `CACHE_DIR=${realPaths.cache}`,
    '-D',
    `NESSY_DIR=${realPaths.nessy}`,
    '-D',
    `RUNTIME_DIR=${realPaths.runtime}`,
    '-D',
    `INCLUDE_DIR_0=${realPaths.target}`,
    '-D',
    `INCLUDE_DIR_1=/dev/null`,
    '-D',
    `INCLUDE_DIR_2=/dev/null`,
    '-D',
    `INCLUDE_DIR_3=/dev/null`,
    '-D',
    `INCLUDE_DIR_4=/dev/null`,
  ];
}

let canApplySeatbeltProfileResult: boolean | undefined;

function canApplySeatbeltProfile(): boolean {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    return false;
  }

  canApplySeatbeltProfileResult ??= (() => {
    const root = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'nessy-seatbelt-preflight-')),
    );

    try {
      const profileFile = path.join(root, 'allow-default.sb');
      writeFileSync(profileFile, '(version 1)\n(allow default)\n');

      const result = spawnSync(
        '/usr/bin/sandbox-exec',
        ['-f', profileFile, '/usr/bin/true'],
        { encoding: 'utf8' },
      );

      return result.status === 0;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  })();

  return canApplySeatbeltProfileResult;
}

function getSpawnFailure(result: ReturnType<typeof spawnSync>): string {
  const parts: string[] = [];
  if (result.error) {
    parts.push(result.error.message);
  }
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  }
  if (result.status !== 0) {
    parts.push(`status=${result.status ?? 'null'}`);
    parts.push(spawnOutputToString(result.stderr || result.stdout));
  }

  return parts.filter(Boolean).join('\n');
}

function spawnOutputToString(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (output == null) {
    return '';
  }
  if (Buffer.isBuffer(output)) {
    return output.toString('utf8');
  }

  return String(output);
}

// [nessy-fork] macos-internal-seatbelt-profile
describe('macOS model Seatbelt profiles', () => {
  it('has matching .sb assets for all built-in profiles', () => {
    const missingProfiles = getBuiltinSeatbeltProfiles().filter(
      (profile) =>
        !existsSync(path.join(UTILS_DIR, `sandbox-macos-${profile}.sb`)),
    );

    expect(missingProfiles).toEqual([]);
  });

  it('allows the macOS TLS trust evaluation service', () => {
    const profileSource = readFileSync(
      path.join(UTILS_DIR, 'sandbox-macos-external-model-open.sb'),
      'utf8',
    );

    expect(profileSource).toContain(
      '(global-name "com.apple.TrustEvaluationAgent")',
    );
  });

  it('keeps external-model and internal-model profile boundaries distinct', () => {
    const externalProfileSource = readFileSync(
      path.join(UTILS_DIR, 'sandbox-macos-external-model-open.sb'),
      'utf8',
    );
    const internalProfileSource = readFileSync(
      path.join(UTILS_DIR, 'sandbox-macos-internal-model-open.sb'),
      'utf8',
    );

    expect(externalProfileSource).toContain('(allow network*)');
    expect(externalProfileSource).not.toContain('(remote ip "localhost:*")');
    expect(externalProfileSource).toContain('(remote ip "localhost:1")');
    expect(externalProfileSource).toContain('(remote ip "localhost:1023")');
    expect(externalProfileSource).toContain('(remote ip "localhost:2375")');
    expect(externalProfileSource).toContain('(remote ip "localhost:2376")');
    expect(externalProfileSource).toContain(
      '(remote unix-socket (path-literal "/var/run/docker.sock"))',
    );
    expect(externalProfileSource).not.toMatch(/^\(allow mach-lookup\)$/m);
    expect(externalProfileSource).not.toContain('(allow mach-register)');
    expect(externalProfileSource).not.toContain('(allow iokit-open)');
    expect(externalProfileSource).not.toContain(
      '/Library/Caches/ms-playwright',
    );

    expect(internalProfileSource).toContain('(allow network*)');
    expect(internalProfileSource).not.toContain('(remote ip "localhost:*")');
    expect(internalProfileSource).toContain('(remote ip "localhost:1")');
    expect(internalProfileSource).toContain('(remote ip "localhost:1023")');
    expect(internalProfileSource).toContain('(remote ip "localhost:2375")');
    expect(internalProfileSource).toContain('(remote ip "localhost:2376")');
    expect(internalProfileSource).toContain(
      '(remote unix-socket (path-literal "/var/run/docker.sock"))',
    );
    expect(internalProfileSource).toMatch(/^\(allow mach-lookup\)$/m);
    expect(internalProfileSource).toContain('(allow mach-register)');
    expect(internalProfileSource).toContain('(allow iokit-open)');
    expect(internalProfileSource).toContain('/Library/Caches/ms-playwright');
    expect(internalProfileSource).toContain(
      '/Library/Application Support/Google',
    );
    expect(internalProfileSource).toContain(
      '/Library/Application Support/BraveSoftware',
    );
    expect(internalProfileSource).toContain(
      '/Library/Application Support/Microsoft Edge',
    );
    expect(internalProfileSource).toContain('/Library/Application Support/Arc');
  });

  it('opens dp state in both model profiles', () => {
    const externalProfileSource = readFileSync(
      path.join(UTILS_DIR, 'sandbox-macos-external-model-open.sb'),
      'utf8',
    );
    const internalProfileSource = readFileSync(
      path.join(UTILS_DIR, 'sandbox-macos-internal-model-open.sb'),
      'utf8',
    );
    const dpStateAllow =
      '(allow file-read* file-write*\n    (subpath (string-append (param "HOME_DIR") "/.dp")))';

    expect(externalProfileSource).toContain(dpStateAllow);
    expect(internalProfileSource).toContain(dpStateAllow);
  });

  it.runIf(canApplySeatbeltProfile())('compiles with sandbox-exec', () => {
    const root = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'nessy-seatbelt-test-')),
    );

    try {
      const params = createSeatbeltParamArgs(root);

      const failures: string[] = [];

      for (const profile of getBuiltinSeatbeltProfiles()) {
        const profileFile = path.join(UTILS_DIR, `sandbox-macos-${profile}.sb`);
        const result = spawnSync(
          '/usr/bin/sandbox-exec',
          [...params, '-f', profileFile, '/usr/bin/true'],
          { encoding: 'utf8' },
        );

        const failure = getSpawnFailure(result);
        if (failure) {
          failures.push(`${profile}: ${failure}`);
        }
      }

      expect(failures).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(canApplySeatbeltProfile() && existsSync('/usr/bin/git'))(
    'allows git global config lockfile writes',
    () => {
      const root = realpathSync(
        mkdtempSync(path.join(os.tmpdir(), 'nessy-seatbelt-git-test-')),
      );

      try {
        const params = createSeatbeltParamArgs(root);
        const home = realpathSync(path.join(root, 'home'));
        for (const profile of MODEL_SEATBELT_PROFILES) {
          const profileFile = path.join(
            UTILS_DIR,
            `sandbox-macos-${profile}.sb`,
          );
          const result = spawnSync(
            '/usr/bin/sandbox-exec',
            [
              ...params,
              '-f',
              profileFile,
              '/usr/bin/env',
              `HOME=${home}`,
              '/usr/bin/git',
              'config',
              '--global',
              '--add',
              'seatbelt.smoke',
              'ok',
            ],
            { encoding: 'utf8' },
          );

          expect(getSpawnFailure(result)).toBe('');
        }
        expect(readFileSync(path.join(home, '.gitconfig'), 'utf8')).toContain(
          'smoke = ok',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(canApplySeatbeltProfile())(
    'allows package manager cache writes',
    () => {
      const root = realpathSync(
        mkdtempSync(path.join(os.tmpdir(), 'nessy-seatbelt-cache-test-')),
      );
      const cachePaths = [
        'Library/Caches/pip',
        'Library/Caches/uv',
        'Library/Caches/pypoetry',
        'Library/Caches/Yarn',
        'Library/Caches/deno',
        'Library/Caches/go-build',
        'Library/pnpm',
        'Library/Application Support/pypoetry',
        '.conda',
      ];

      try {
        const params = createSeatbeltParamArgs(root);
        const home = realpathSync(path.join(root, 'home'));
        mkdirSync(path.join(home, 'Library', 'Caches'), { recursive: true });
        mkdirSync(path.join(home, 'Library', 'Application Support'), {
          recursive: true,
        });
        const script = [
          'set -e',
          ...cachePaths.map(
            (relativePath, index) =>
              `mkdir -p "$HOME/${relativePath}" && printf ${index} > "$HOME/${relativePath}/seatbelt-smoke"`,
          ),
        ].join('\n');
        for (const profile of MODEL_SEATBELT_PROFILES) {
          const profileFile = path.join(
            UTILS_DIR,
            `sandbox-macos-${profile}.sb`,
          );
          const result = spawnSync(
            '/usr/bin/sandbox-exec',
            [
              ...params,
              '-f',
              profileFile,
              '/usr/bin/env',
              `HOME=${home}`,
              '/bin/sh',
              '-c',
              script,
            ],
            { encoding: 'utf8' },
          );

          expect(getSpawnFailure(result)).toBe('');
        }
        for (const [index, relativePath] of cachePaths.entries()) {
          expect(
            readFileSync(
              path.join(home, relativePath, 'seatbelt-smoke'),
              'utf8',
            ),
          ).toBe(String(index));
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(canApplySeatbeltProfile())('keeps trusted folders immutable', () => {
    const root = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), 'nessy-seatbelt-trust-test-')),
    );

    try {
      const params = createSeatbeltParamArgs(root);
      const home = realpathSync(path.join(root, 'home'));
      const nessy = realpathSync(path.join(root, 'nessy'));
      const trustedFoldersPath = path.join(nessy, 'trustedFolders.json');
      const originalTrustedFolders = '{"/repo":"TRUST_FOLDER"}\n';
      writeFileSync(trustedFoldersPath, originalTrustedFolders);

      const script = [
        'set -e',
        'cat "$NESSY_DIR/trustedFolders.json" >/dev/null',
        'if printf direct > "$NESSY_DIR/trustedFolders.json"; then echo direct-write-allowed; exit 11; fi',
        'if printf atomic > "$NESSY_DIR/trustedFolders.json.atomic-test.tmp"; then',
        '  if mv "$NESSY_DIR/trustedFolders.json.atomic-test.tmp" "$NESSY_DIR/trustedFolders.json"; then',
        '    echo atomic-rename-allowed',
        '    exit 12',
        '  fi',
        '  rm -f "$NESSY_DIR/trustedFolders.json.atomic-test.tmp"',
        'fi',
        'if rm "$NESSY_DIR/trustedFolders.json"; then echo unlink-allowed; exit 13; fi',
      ].join('\n');
      for (const profile of MODEL_SEATBELT_PROFILES) {
        const profileFile = path.join(UTILS_DIR, `sandbox-macos-${profile}.sb`);
        const result = spawnSync(
          '/usr/bin/sandbox-exec',
          [
            ...params,
            '-f',
            profileFile,
            '/usr/bin/env',
            `HOME=${home}`,
            `NESSY_DIR=${nessy}`,
            '/bin/sh',
            '-c',
            script,
          ],
          { encoding: 'utf8' },
        );

        expect(getSpawnFailure(result)).toBe('');
      }
      expect(readFileSync(trustedFoldersPath, 'utf8')).toBe(
        originalTrustedFolders,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(canApplySeatbeltProfile())(
    'blocks shell history and Chromium-family profiles',
    () => {
      const root = realpathSync(
        mkdtempSync(path.join(os.tmpdir(), 'nessy-seatbelt-secrets-test-')),
      );
      const blockedPaths = [
        '.zsh_history',
        '.bash_history',
        'Library/Application Support/BraveSoftware/profile.db',
        'Library/Application Support/Microsoft Edge/profile.db',
        'Library/Application Support/Arc/profile.db',
      ];

      try {
        const params = createSeatbeltParamArgs(root);
        const home = realpathSync(path.join(root, 'home'));
        for (const relativePath of blockedPaths) {
          const blockedPath = path.join(home, relativePath);
          mkdirSync(path.dirname(blockedPath), { recursive: true });
          writeFileSync(blockedPath, 'secret\n');
        }
        const script = [
          'set -e',
          'for path in "$HOME/.zsh_history" "$HOME/.bash_history" "$HOME/Library/Application Support/BraveSoftware/profile.db" "$HOME/Library/Application Support/Microsoft Edge/profile.db" "$HOME/Library/Application Support/Arc/profile.db"; do',
          '  if cat "$path" >/dev/null 2>&1; then',
          '    echo "read-allowed:$path"',
          '    exit 20',
          '  fi',
          'done',
        ].join('\n');
        for (const profile of MODEL_SEATBELT_PROFILES) {
          const profileFile = path.join(
            UTILS_DIR,
            `sandbox-macos-${profile}.sb`,
          );
          const result = spawnSync(
            '/usr/bin/sandbox-exec',
            [
              ...params,
              '-f',
              profileFile,
              '/usr/bin/env',
              `HOME=${home}`,
              '/bin/sh',
              '-c',
              script,
            ],
            { encoding: 'utf8' },
          );

          expect(getSpawnFailure(result)).toBe('');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(canApplySeatbeltProfile())(
    'allows corporate CA read in both model profiles',
    () => {
      const root = realpathSync(
        mkdtempSync(path.join(os.tmpdir(), 'nessy-seatbelt-dp-test-')),
      );

      try {
        const params = createSeatbeltParamArgs(root);
        const home = realpathSync(path.join(root, 'home'));
        mkdirSync(path.join(home, '.ssh'), { recursive: true });
        writeFileSync(path.join(home, '.ssh', 'combined-ca.pem'), 'ca\n');

        for (const profile of MODEL_SEATBELT_PROFILES) {
          const profileFile = path.join(
            UTILS_DIR,
            `sandbox-macos-${profile}.sb`,
          );
          const result = spawnSync(
            '/usr/bin/sandbox-exec',
            [
              ...params,
              '-f',
              profileFile,
              '/usr/bin/env',
              `HOME=${home}`,
              '/bin/sh',
              '-c',
              'cat "$HOME/.ssh/combined-ca.pem"',
            ],
            { encoding: 'utf8' },
          );

          expect(getSpawnFailure(result)).toBe('');
          expect(result.stdout).toContain('ca');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(canApplySeatbeltProfile())(
    'allows dp state in both model profiles',
    () => {
      const root = realpathSync(
        mkdtempSync(path.join(os.tmpdir(), 'nessy-seatbelt-dp-state-test-')),
      );

      try {
        const params = createSeatbeltParamArgs(root);
        const home = realpathSync(path.join(root, 'home'));
        const dpState = path.join(home, '.dp', 'access_token.json');
        mkdirSync(path.dirname(dpState), { recursive: true });

        for (const profile of MODEL_SEATBELT_PROFILES) {
          writeFileSync(dpState, `${profile}-secret\n`);
          const result = spawnSync(
            '/usr/bin/sandbox-exec',
            [
              ...params,
              '-f',
              path.join(UTILS_DIR, `sandbox-macos-${profile}.sb`),
              '/usr/bin/env',
              `HOME=${home}`,
              '/bin/sh',
              '-c',
              'cat "$HOME/.dp/access_token.json" && printf token > "$HOME/.dp/access_token.json"',
            ],
            { encoding: 'utf8' },
          );

          expect(getSpawnFailure(result)).toBe('');
          expect(result.stdout).toContain(`${profile}-secret`);
          expect(readFileSync(dpState, 'utf8')).toBe('token');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
