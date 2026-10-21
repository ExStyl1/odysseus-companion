/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the DP binary download / validation / update pipeline.
 *
 * Uses a real temporary NESSY_HOME so the atomic-rename and temp-cleanup
 * behaviour is exercised for real; only the network (fetch) and the binary
 * invocations (execFile) are mocked.
 */

// [nessy-fork] dp-binary-lifecycle

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PAYLOAD = 'fake-dp-binary-payload';
const PAYLOAD_MD5 = crypto.createHash('md5').update(PAYLOAD).digest('hex');
const VERSION_OUTPUT =
  'Spirit CLI Version: 13.36.15 prod (darwin_amd64) Build: abc123\n';

/** Controls what a mocked `dp <args>` invocation does. */
const execBehavior = vi.hoisted(() => ({
  version: { ok: true },
  update: { ok: true },
  /** Records every invocation as a plain "arg arg" string. */
  calls: [] as string[],
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    platform: vi.fn(actual.platform),
    arch: vi.fn(actual.arch),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (
    file: string,
    args: string[],
    _options: unknown,
    callback: (err: Error | null, stdout?: string, stderr?: string) => void,
  ) => {
    const joined = args.join(' ');
    execBehavior.calls.push(joined);

    const fail = (message: string) => callback(new Error(message), '', message);

    if (joined === '--version') {
      if (!execBehavior.version.ok) return fail('spawn EACCES');
      return callback(null, VERSION_OUTPUT, '');
    }
    if (joined === 'update') {
      if (!execBehavior.update.ok) return fail('update failed');
      return callback(null, 'dp is already the latest version\n', '');
    }
    return fail(`unexpected args: ${joined}`);
  };
  // promisify must yield { stdout, stderr }, matching real execFile.
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: string,
    args: string[],
    options: unknown,
  ) =>
    new Promise((resolve, reject) => {
      execFile(file, args, options, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });

  return { ...actual, execFile };
});

// Keep the real path helpers, but pin the checksum to our fake payload.
vi.mock('./dp-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dp-config.js')>();
  return {
    ...actual,
    DP_CONFIG: {
      ...actual.DP_CONFIG,
      md5Checksums: {
        win32: PAYLOAD_MD5,
        linux: PAYLOAD_MD5,
        darwin: PAYLOAD_MD5,
      } as Record<string, string>,
    },
  };
});

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function respondWith(body: string, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  };
}

describe('ensureDpPresence', () => {
  const originalNessyHome = process.env['NESSY_HOME'];
  let tmpHome: string;
  let dpPath: string;
  let ensureDpPresence: (typeof import('./dp-downloader.js'))['ensureDpPresence'];
  let DpAuthError: (typeof import('./dp-errors.js'))['DpAuthError'];

  beforeEach(async () => {
    vi.mocked(os.platform).mockReturnValue(process.platform);
    vi.mocked(os.arch).mockReturnValue(process.arch);
    tmpHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'dp-test-'));
    process.env['NESSY_HOME'] = tmpHome;

    execBehavior.version = { ok: true };
    execBehavior.update = { ok: true };
    execBehavior.calls = [];
    mockFetch.mockReset();
    // A fresh response per call: the body stream can only be consumed once.
    mockFetch.mockImplementation(() => Promise.resolve(respondWith(PAYLOAD)));

    // Fresh module instances so the single-flight state does not leak.
    vi.resetModules();
    ({ ensureDpPresence } = await import('./dp-downloader.js'));
    ({ DpAuthError } = await import('./dp-errors.js'));

    const { getDpFilePath } = await import('./dp-config.js');
    dpPath = getDpFilePath();
  });

  afterEach(async () => {
    if (originalNessyHome === undefined) {
      delete process.env['NESSY_HOME'];
    } else {
      process.env['NESSY_HOME'] = originalNessyHome;
    }
    await fsPromises.rm(tmpHome, { recursive: true, force: true });
  });

  /** Files left in the DP folder besides the binary itself. */
  const leftoverFiles = () =>
    fs
      .readdirSync(path.dirname(dpPath))
      .filter((name) => name !== 'dp' && name !== '.universal-v1');

  it('downloads and validates on a cold start', async () => {
    await ensureDpPresence();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(dpPath, 'utf8')).toBe(PAYLOAD);
    // Validated by running it — no update is triggered here (that is a
    // background concern, decoupled from startup).
    expect(execBehavior.calls).toEqual(['--version']);
    expect(leftoverFiles()).toEqual([]);
  });

  it.each([
    ['darwin', 'x64', '13.65.1/darwin/universal/dp'],
    ['darwin', 'arm64', '13.65.1/darwin/universal/dp'],
    ['win32', 'x64', '13.65.1/windows/dp.exe'],
    ['linux', 'x64', '13.65.1/linux/dp'],
  ] as const)(
    'downloads the pinned artifact for %s/%s',
    async (platform, arch, artifact) => {
      vi.mocked(os.platform).mockReturnValue(platform);
      vi.mocked(os.arch).mockReturnValue(arch);

      await ensureDpPresence();

      expect(mockFetch).toHaveBeenCalledExactlyOnceWith(
        `https://code-completion-nestor.tcsbank.ru/api/v2/download/dp/${artifact}`,
        expect.objectContaining({ method: 'GET' }),
      );
      expect(
        fs.existsSync(path.join(tmpHome, 'dp_latest', '.universal-v1')),
      ).toBe(platform === 'darwin');
    },
  );

  // Windows has no POSIX execute bit, so there is nothing to assert there.
  it.skipIf(os.platform() === 'win32')(
    'sets the execute bit before running the binary',
    async () => {
      await ensureDpPresence();

      const mode = fs.statSync(dpPath).mode & 0o777;
      expect(mode & 0o100).toBe(0o100);
      expect(mode).toBe(0o700);
    },
  );

  it('re-downloads a binary that exists but cannot run', async () => {
    fs.mkdirSync(path.dirname(dpPath), { recursive: true });
    fs.writeFileSync(dpPath, 'garbage');
    fs.writeFileSync(path.join(path.dirname(dpPath), '.universal-v1'), '');

    // Fails while the corrupted file is in place, succeeds once replaced.
    execBehavior.version.ok = false;
    mockFetch.mockImplementation(() => {
      execBehavior.version.ok = true;
      return Promise.resolve(respondWith(PAYLOAD));
    });

    await ensureDpPresence();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(dpPath, 'utf8')).toBe(PAYLOAD);
  });

  it('does not re-download a healthy binary', async () => {
    fs.mkdirSync(path.dirname(dpPath), { recursive: true });
    fs.writeFileSync(dpPath, 'existing', { mode: 0o700 });
    fs.writeFileSync(path.join(path.dirname(dpPath), '.universal-v1'), '');

    await ensureDpPresence();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(dpPath, 'utf8')).toBe('existing');
    expect(execBehavior.calls).toEqual(['--version']);
  });

  it('does not run dp update from ensureDpPresence', async () => {
    fs.mkdirSync(path.dirname(dpPath), { recursive: true });
    fs.writeFileSync(dpPath, 'stale', { mode: 0o700 });
    fs.writeFileSync(path.join(path.dirname(dpPath), '.universal-v1'), '');
    execBehavior.update.ok = false;

    await ensureDpPresence();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(dpPath, 'utf8')).toBe('stale');
    expect(execBehavior.calls).toEqual(['--version']);
  });

  it.each(['darwin', 'linux', 'win32'] as const)(
    'migrates the installed binary once only on macOS (%s)',
    async (platform) => {
      vi.mocked(os.platform).mockReturnValue(platform);
      const { getDpFilePath } = await import('./dp-config.js');
      dpPath = getDpFilePath();
      const marker = path.join(path.dirname(dpPath), '.universal-v1');
      fs.mkdirSync(path.dirname(dpPath), { recursive: true });
      fs.writeFileSync(dpPath, 'existing', { mode: 0o700 });

      await ensureDpPresence();
      await ensureDpPresence();

      expect(mockFetch).toHaveBeenCalledTimes(platform === 'darwin' ? 1 : 0);
      expect(fs.existsSync(marker)).toBe(platform === 'darwin');
      expect(fs.readFileSync(dpPath, 'utf8')).toBe(
        platform === 'darwin' ? PAYLOAD : 'existing',
      );
    },
  );

  it.each(['download', 'checksum', 'execution'])(
    'keeps the old DP without a marker on migration %s failure and retries',
    async (failure) => {
      vi.mocked(os.platform).mockReturnValue('darwin');
      const { getDpFilePath } = await import('./dp-config.js');
      dpPath = getDpFilePath();
      const marker = path.join(path.dirname(dpPath), '.universal-v1');
      fs.mkdirSync(path.dirname(dpPath), { recursive: true });
      fs.writeFileSync(dpPath, 'existing', { mode: 0o700 });
      mockFetch.mockImplementationOnce(() => {
        execBehavior.version.ok = failure !== 'execution';
        return Promise.resolve(
          respondWith(
            failure === 'checksum' ? 'invalid' : PAYLOAD,
            failure !== 'download',
          ),
        );
      });

      await expect(ensureDpPresence()).resolves.toBeUndefined();

      expect(fs.readFileSync(dpPath, 'utf8')).toBe('existing');
      expect(fs.existsSync(marker)).toBe(false);
      expect(execBehavior.calls).not.toContain('update');
      expect(leftoverFiles()).toEqual([]);

      execBehavior.version.ok = true;
      await ensureDpPresence();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.readFileSync(dpPath, 'utf8')).toBe(PAYLOAD);
    },
  );

  it('does not let the migration marker hide a missing binary', async () => {
    vi.mocked(os.platform).mockReturnValue('darwin');
    fs.mkdirSync(path.join(tmpHome, 'dp_latest'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'dp_latest', '.universal-v1'), '');

    await ensureDpPresence();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(tmpHome, 'dp_latest', 'dp'), 'utf8')).toBe(
      PAYLOAD,
    );
  });

  it('does not reinstall a freshly downloaded binary', async () => {
    await expect(ensureDpPresence()).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(execBehavior.calls).toEqual(['--version']);
  });

  it('rejects a checksum mismatch without touching the live binary', async () => {
    fs.mkdirSync(path.dirname(dpPath), { recursive: true });
    fs.writeFileSync(dpPath, 'good-binary', { mode: 0o700 });
    execBehavior.version.ok = false;
    mockFetch.mockImplementation(() =>
      Promise.resolve(respondWith('tampered-payload')),
    );

    await expect(ensureDpPresence()).rejects.toThrow(
      DpAuthError.ChecksumMismatch,
    );

    expect(fs.readFileSync(dpPath, 'utf8')).toBe('good-binary');
    expect(leftoverFiles()).toEqual([]);
  });

  it('cleans up the temp file when the download fails', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(respondWith('', false)));

    await expect(ensureDpPresence()).rejects.toThrow(
      DpAuthError.DownloadFailed,
    );

    expect(fs.existsSync(dpPath)).toBe(false);
    expect(leftoverFiles()).toEqual([]);
  });

  it('fails when a freshly downloaded binary cannot run', async () => {
    execBehavior.version.ok = false;

    await expect(ensureDpPresence()).rejects.toThrow(DpAuthError.CantInit);

    expect(fs.existsSync(dpPath)).toBe(false);
    expect(leftoverFiles()).toEqual([]);
  });

  it('shares a single inflight run between concurrent callers', async () => {
    await Promise.all([
      ensureDpPresence(),
      ensureDpPresence(),
      ensureDpPresence(),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(execBehavior.calls).toEqual(['--version']);
  });

  it('handles a NESSY_HOME containing spaces', async () => {
    const spacedHome = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'dp test home '),
    );
    process.env['NESSY_HOME'] = spacedHome;
    vi.resetModules();
    const downloader = await import('./dp-downloader.js');
    const { getDpFilePath } = await import('./dp-config.js');

    try {
      await downloader.ensureDpPresence();
      expect(fs.readFileSync(getDpFilePath(), 'utf8')).toBe(PAYLOAD);
    } finally {
      await fsPromises.rm(spacedHome, { recursive: true, force: true });
    }
  });
});

describe('installDpVersion', () => {
  const originalNessyHome = process.env['NESSY_HOME'];
  let tmpHome: string;
  let dpPath: string;
  let installDpVersion: (typeof import('./dp-downloader.js'))['installDpVersion'];

  beforeEach(async () => {
    vi.mocked(os.platform).mockReturnValue(process.platform);
    vi.mocked(os.arch).mockReturnValue(process.arch);
    tmpHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'dp-test-'));
    process.env['NESSY_HOME'] = tmpHome;

    execBehavior.version = { ok: true };
    execBehavior.update = { ok: true };
    execBehavior.calls = [];
    mockFetch.mockReset();
    mockFetch.mockImplementation(() => Promise.resolve(respondWith(PAYLOAD)));

    vi.resetModules();
    ({ installDpVersion } = await import('./dp-downloader.js'));

    const { getDpFilePath } = await import('./dp-config.js');
    dpPath = getDpFilePath();
  });

  afterEach(async () => {
    if (originalNessyHome === undefined) {
      delete process.env['NESSY_HOME'];
    } else {
      process.env['NESSY_HOME'] = originalNessyHome;
    }
    await fsPromises.rm(tmpHome, { recursive: true, force: true });
  });

  const leftoverFiles = () =>
    fs
      .readdirSync(path.dirname(dpPath))
      .filter((name) => name !== 'dp' && name !== '.universal-v1');

  it('downloads and installs the requested version directly', async () => {
    await expect(installDpVersion('13.66.0')).resolves.toBe(true);

    expect(fs.readFileSync(dpPath, 'utf8')).toBe(PAYLOAD);
    // Validated by running it, without any `dp update` call.
    expect(execBehavior.calls).toEqual(['--version']);
    expect(leftoverFiles()).toEqual([]);
  });

  it('downloads from the requested version URL', async () => {
    await installDpVersion('13.66.0');

    expect(mockFetch).toHaveBeenCalledExactlyOnceWith(
      `https://code-completion-nestor.tcsbank.ru/api/v2/download/dp/13.66.0/darwin/universal/dp`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('does not install a binary that cannot run', async () => {
    execBehavior.version.ok = false;

    await expect(installDpVersion('13.66.0')).resolves.toBe(false);

    expect(fs.existsSync(dpPath)).toBe(false);
    expect(leftoverFiles()).toEqual([]);
  });

  it('reports failure instead of throwing on download error', async () => {
    mockFetch.mockImplementation(() => Promise.resolve(respondWith('', false)));

    await expect(installDpVersion('13.66.0')).resolves.toBe(false);

    expect(fs.existsSync(dpPath)).toBe(false);
    expect(leftoverFiles()).toEqual([]);
  });
});
