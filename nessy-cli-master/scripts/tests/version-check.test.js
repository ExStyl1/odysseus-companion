import { vi, describe, it, expect, beforeEach } from 'vitest';
import { parseTag, checkVersions } from '../version-check.js';
import { readFileSync } from 'node:fs';

vi.mock('node:fs');

describe('parseTag', () => {
  it('should parse a beta cli tag', () => {
    const result = parseTag('release-cli-1.2.3-beta.0');
    expect(result).toEqual({
      componentType: 'cli',
      tagVersion: '1.2.3-beta.0',
    });
  });

  it('should parse a stable cli tag', () => {
    const result = parseTag('release-cli-1.2.3');
    expect(result).toEqual({ componentType: 'cli', tagVersion: '1.2.3' });
  });

  it('should parse an sdk-typescript tag', () => {
    const result = parseTag('release-sdk-typescript-0.5.0');
    expect(result).toEqual({
      componentType: 'sdk-typescript',
      tagVersion: '0.5.0',
    });
  });

  it('should parse an sdk-python tag', () => {
    const result = parseTag('release-sdk-python-1.0.0-beta.1');
    expect(result).toEqual({
      componentType: 'sdk-python',
      tagVersion: '1.0.0-beta.1',
    });
  });

  it('should parse an sdk-java tag', () => {
    const result = parseTag('release-sdk-java-2.0.1');
    expect(result).toEqual({
      componentType: 'sdk-java',
      tagVersion: '2.0.1',
    });
  });
});

describe('checkVersions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function mockFiles(pkgVersion) {
    vi.mocked(readFileSync).mockImplementation((filePath) => {
      if (String(filePath).endsWith('package.json')) {
        return JSON.stringify({ version: pkgVersion });
      }
      throw new Error(`Unexpected file read: ${filePath}`);
    });
  }

  it('should fail for unsupported component type', () => {
    const result = checkVersions('release-sdk-1.0.0', '/project');
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unsupported component type 'sdk'");
  });

  describe('sdk-typescript', () => {
    function mockSdkTs(version) {
      vi.mocked(readFileSync).mockImplementation((filePath) => {
        if (String(filePath).endsWith('packages/sdk-typescript/package.json')) {
          return JSON.stringify({ version });
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      });
    }

    it('should pass when versions match', () => {
      mockSdkTs('0.5.0');
      const result = checkVersions('release-sdk-typescript-0.5.0', '/project');
      expect(result).toEqual({ ok: true });
    });

    it('should fail when versions differ', () => {
      mockSdkTs('0.5.1');
      const result = checkVersions('release-sdk-typescript-0.5.0', '/project');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('sdk-typescript version mismatch');
    });

    it('should pass stable tag with prerelease package version (base match)', () => {
      mockSdkTs('0.5.0-beta.1');
      const result = checkVersions('release-sdk-typescript-0.5.0', '/project');
      expect(result).toEqual({ ok: true });
    });
  });

  describe('sdk-python', () => {
    function mockSdkPy(version) {
      vi.mocked(readFileSync).mockImplementation((filePath) => {
        if (String(filePath).endsWith('packages/sdk-python/pyproject.toml')) {
          return `[project]\nname = "nessy-cli-sdk"\nversion = "${version}"\n`;
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      });
    }

    it('should pass when versions match', () => {
      mockSdkPy('1.0.0');
      const result = checkVersions('release-sdk-python-1.0.0', '/project');
      expect(result).toEqual({ ok: true });
    });

    it('should fail when versions differ', () => {
      mockSdkPy('1.0.1');
      const result = checkVersions('release-sdk-python-1.0.0', '/project');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('sdk-python version mismatch');
    });

    it('should pass stable tag with prerelease package version (base match)', () => {
      mockSdkPy('1.0.0-beta.2');
      const result = checkVersions('release-sdk-python-1.0.0', '/project');
      expect(result).toEqual({ ok: true });
    });
  });

  describe('sdk-java', () => {
    function mockSdkJava(version) {
      vi.mocked(readFileSync).mockImplementation((filePath) => {
        if (String(filePath).endsWith('packages/sdk-java/nessycli/pom.xml')) {
          return `<project><version>${version}</version></project>`;
        }
        throw new Error(`Unexpected file read: ${filePath}`);
      });
    }

    it('should pass when versions match', () => {
      mockSdkJava('2.0.1');
      const result = checkVersions('release-sdk-java-2.0.1', '/project');
      expect(result).toEqual({ ok: true });
    });

    it('should fail when versions differ', () => {
      mockSdkJava('2.0.2');
      const result = checkVersions('release-sdk-java-2.0.1', '/project');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('sdk-java version mismatch');
    });

    it('should pass stable tag when pom has -SNAPSHOT suffix', () => {
      mockSdkJava('0.0.4-SNAPSHOT');
      const result = checkVersions('release-sdk-java-0.0.4', '/project');
      expect(result).toEqual({ ok: true });
    });

    it('should pass SNAPSHOT.N tag matching pom -SNAPSHOT base', () => {
      mockSdkJava('0.0.4-SNAPSHOT');
      const result = checkVersions(
        'release-sdk-java-0.0.4-SNAPSHOT.2',
        '/project',
      );
      expect(result).toEqual({ ok: true });
    });

    it('should fail stable tag when pom base version differs', () => {
      mockSdkJava('0.0.5-SNAPSHOT');
      const result = checkVersions('release-sdk-java-0.0.4', '/project');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('sdk-java version mismatch');
    });
  });

  describe('prerelease tags (strict comparison)', () => {
    it('should pass when beta versions match exactly', () => {
      mockFiles('1.2.3-beta.0');
      const result = checkVersions('release-cli-1.2.3-beta.0', '/project');
      expect(result).toEqual({ ok: true });
    });

    it('should pass when alpha versions match exactly', () => {
      mockFiles('1.2.3-alpha.1');
      const result = checkVersions('release-cli-1.2.3-alpha.1', '/project');
      expect(result).toEqual({ ok: true });
    });

    it('should fail when package.json beta version differs', () => {
      mockFiles('1.2.3-beta.1');
      const result = checkVersions('release-cli-1.2.3-beta.0', '/project');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('cli version mismatch');
    });

    it('should fail when package.json has no prerelease but tag does', () => {
      mockFiles('1.2.3');
      const result = checkVersions('release-cli-1.2.3-beta.0', '/project');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('cli version mismatch');
    });
  });

  describe('stable tags (base version comparison)', () => {
    it('should pass when versions match exactly', () => {
      mockFiles('1.2.3');
      const result = checkVersions('release-cli-1.2.3', '/project');
      expect(result).toEqual({ ok: true });
    });

    it('should pass when package.json has beta suffix but base matches', () => {
      mockFiles('1.2.3-beta.5');
      const result = checkVersions('release-cli-1.2.3', '/project');
      expect(result).toEqual({ ok: true });
    });

    it('should pass when package.json has alpha suffix but base matches', () => {
      mockFiles('1.2.3-alpha.0');
      const result = checkVersions('release-cli-1.2.3', '/project');
      expect(result).toEqual({ ok: true });
    });

    it('should fail when base version does not match', () => {
      mockFiles('1.2.4-beta.0');
      const result = checkVersions('release-cli-1.2.3', '/project');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('cli version mismatch');
    });
  });
});
