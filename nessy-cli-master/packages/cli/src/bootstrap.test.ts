import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CERT_A = `-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----`;
const CERT_B = `-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----`;

async function importBootstrap() {
  process.env['NESSY_USE_BUNDLED_CA'] = 'false';
  vi.resetModules();
  return await import('./bootstrap.js');
}

describe('resolveBundledCaPath', () => {
  it.each([
    ['bundle', ['dist'], ['dist', 'certs']],
    ['source development', ['packages', 'cli', 'src'], ['certs']],
    ['TypeScript build', ['packages', 'cli', 'dist', 'src'], ['certs']],
  ])('resolves the %s layout', async (_name, moduleParts, certParts) => {
    const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'nessy-ca-')));
    const moduleDir = join(root, ...moduleParts);
    const certPath = join(root, ...certParts, 'tinkoff-bundle.crt');
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(dirname(certPath), { recursive: true });
    writeFileSync(certPath, CERT_A);

    const { resolveBundledCaPath } = await importBootstrap();

    expect(resolveBundledCaPath(moduleDir)).toBe(certPath);
  });

  it('resolves both shipped CA files', async () => {
    const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'nessy-ca-')));
    const moduleDir = join(root, 'dist');
    const certDir = join(moduleDir, 'certs');
    mkdirSync(certDir, { recursive: true });
    writeFileSync(join(certDir, 'tinkoff-bundle.crt'), CERT_A);
    writeFileSync(join(certDir, 'russian-root-ca.crt'), CERT_B);

    const { resolveBundledCaPaths } = await importBootstrap();

    expect(resolveBundledCaPaths(moduleDir)).toEqual([
      join(certDir, 'tinkoff-bundle.crt'),
      join(certDir, 'russian-root-ca.crt'),
    ]);
  });
});

describe('trustExtraCaCertInCurrentProcess', () => {
  let originalCreateSecureContext: typeof tls.createSecureContext;
  let addCACert: ReturnType<typeof vi.fn>;
  let certPath: string;

  beforeEach(() => {
    const dir = realpathSync(mkdtempSync(join(os.tmpdir(), 'nessy-ca-')));
    certPath = join(dir, 'bundle.crt');
    writeFileSync(certPath, `${CERT_A}\n${CERT_B}\n`);

    originalCreateSecureContext = tls.createSecureContext;
    addCACert = vi.fn();
    tls.createSecureContext = vi.fn(
      () => ({ context: { addCACert } }) as unknown as tls.SecureContext,
    );
  });

  afterEach(() => {
    tls.createSecureContext = originalCreateSecureContext;
    delete process.env['NESSY_USE_BUNDLED_CA'];
    delete process.env['NODE_EXTRA_CA_CERTS'];
  });

  it('keeps an external CA and also trusts the bundled certificates', async () => {
    const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'nessy-ca-')));
    const moduleDir = join(root, 'dist');
    const certDir = join(moduleDir, 'certs');
    const homeDir = join(root, 'home');
    mkdirSync(certDir, { recursive: true });
    writeFileSync(join(certDir, 'tinkoff-bundle.crt'), CERT_A);
    writeFileSync(join(certDir, 'russian-root-ca.crt'), CERT_B);
    const { ensureExtraCaCert } = await importBootstrap();
    delete process.env['NESSY_USE_BUNDLED_CA'];
    process.env['NODE_EXTRA_CA_CERTS'] = '/custom/ca.crt';

    ensureExtraCaCert(moduleDir, homeDir, join(root, 'workspace'));
    tls.createSecureContext({});

    expect(process.env['NODE_EXTRA_CA_CERTS']).toBe('/custom/ca.crt');
    expect(addCACert).toHaveBeenCalledTimes(2);
    expect(addCACert).toHaveBeenNthCalledWith(1, CERT_A);
    expect(addCACert).toHaveBeenNthCalledWith(2, CERT_B);
  });

  it('adds every certificate of the bundle to contexts built without a ca', async () => {
    const { trustExtraCaCertInCurrentProcess } = await importBootstrap();

    trustExtraCaCertInCurrentProcess(certPath);
    tls.createSecureContext({});

    expect(addCACert).toHaveBeenCalledTimes(2);
    expect(addCACert).toHaveBeenNthCalledWith(1, CERT_A);
    expect(addCACert).toHaveBeenNthCalledWith(2, CERT_B);
  });

  it('adds certificates from separate CA files', async () => {
    const secondCertPath = join(dirname(certPath), 'russian-root-ca.crt');
    writeFileSync(certPath, CERT_A);
    writeFileSync(secondCertPath, CERT_B);
    const { trustExtraCaCertInCurrentProcess } = await importBootstrap();

    trustExtraCaCertInCurrentProcess([certPath, secondCertPath]);
    tls.createSecureContext({});

    expect(addCACert).toHaveBeenCalledTimes(2);
    expect(addCACert).toHaveBeenNthCalledWith(1, CERT_A);
    expect(addCACert).toHaveBeenNthCalledWith(2, CERT_B);
  });

  it('leaves contexts that pin their own ca untouched', async () => {
    const { trustExtraCaCertInCurrentProcess } = await importBootstrap();

    trustExtraCaCertInCurrentProcess(certPath);
    tls.createSecureContext({ ca: 'pinned' });

    expect(addCACert).not.toHaveBeenCalled();
  });

  it('patches tls.createSecureContext only once', async () => {
    const { trustExtraCaCertInCurrentProcess } = await importBootstrap();

    trustExtraCaCertInCurrentProcess(certPath);
    trustExtraCaCertInCurrentProcess(certPath);
    tls.createSecureContext({});

    expect(addCACert).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the bundle holds no certificate', async () => {
    const { trustExtraCaCertInCurrentProcess } = await importBootstrap();
    const emptyPath = join(
      realpathSync(mkdtempSync(join(os.tmpdir(), 'nessy-ca-'))),
      'bundle.crt',
    );
    writeFileSync(emptyPath, 'not a certificate\n');
    const before = tls.createSecureContext;

    trustExtraCaCertInCurrentProcess(emptyPath);

    expect(tls.createSecureContext).toBe(before);
  });
});
