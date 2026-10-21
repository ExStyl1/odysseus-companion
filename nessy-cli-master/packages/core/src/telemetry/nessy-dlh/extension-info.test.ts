import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../../config/config.js';
import {
  resolveMcpExtensionInfo,
  resolveSkillExtensionInfo,
  resolveSubagentExtensionInfo,
  resolveCommandExtensionInfo,
} from './extension-info.js';

type ActiveExtensions = ReturnType<Config['getActiveExtensions']>;

/** Build a fake Config exposing the given active extensions. */
function configWith(extensions: unknown[]): Config {
  return {
    getActiveExtensions: () => extensions as ActiveExtensions,
  } as unknown as Config;
}

const extPdf = {
  name: 'ext-pdf',
  installMetadata: { source: 'git:pdf-ext', type: 'git' },
  skills: [{ name: 'pdf' }],
  agents: [{ name: 'reviewer' }],
  commands: ['dlh-test'],
  mcpServers: { 'pdf-mcp': { command: 'node' } },
};

const extNoMeta = {
  name: 'ext-linked',
  // no installMetadata (e.g. linked/dev extension)
  skills: [{ name: 'linked-skill' }],
};

describe('extension-info resolvers (getActiveExtensions scan)', () => {
  describe('resolveMcpExtensionInfo', () => {
    it('attributes an MCP server provided by an extension', () => {
      expect(resolveMcpExtensionInfo(configWith([extPdf]), 'pdf-mcp')).toEqual({
        extension_name: 'ext-pdf',
        extension_source: 'git:pdf-ext',
      });
    });

    it('returns nulls for a non-extension / unknown server', () => {
      expect(resolveMcpExtensionInfo(configWith([extPdf]), 'other')).toEqual({
        extension_name: null,
        extension_source: null,
      });
      expect(resolveMcpExtensionInfo(configWith([extPdf]), null)).toEqual({
        extension_name: null,
        extension_source: null,
      });
    });
  });

  describe('resolveSkillExtensionInfo', () => {
    it('attributes an extension skill', () => {
      expect(resolveSkillExtensionInfo(configWith([extPdf]), 'pdf')).toEqual({
        extension_name: 'ext-pdf',
        extension_source: 'git:pdf-ext',
      });
    });

    it('returns null source when the extension has no install metadata', () => {
      expect(
        resolveSkillExtensionInfo(configWith([extNoMeta]), 'linked-skill'),
      ).toEqual({ extension_name: 'ext-linked', extension_source: null });
    });

    it('returns nulls for a non-extension skill', () => {
      expect(
        resolveSkillExtensionInfo(configWith([extPdf]), 'project-only'),
      ).toEqual({ extension_name: null, extension_source: null });
    });
  });

  describe('resolveSubagentExtensionInfo', () => {
    it('attributes an extension subagent', () => {
      expect(
        resolveSubagentExtensionInfo(configWith([extPdf]), 'reviewer'),
      ).toEqual({ extension_name: 'ext-pdf', extension_source: 'git:pdf-ext' });
    });

    it('returns nulls for a fork / builtin subagent', () => {
      expect(resolveSubagentExtensionInfo(configWith([extPdf]), null)).toEqual({
        extension_name: null,
        extension_source: null,
      });
      expect(
        resolveSubagentExtensionInfo(configWith([extPdf]), 'general-purpose'),
      ).toEqual({ extension_name: null, extension_source: null });
    });
  });

  describe('resolveCommandExtensionInfo', () => {
    // Command attribution checks the command file on disk (ext.commands from
    // the manager is `.md`-only and misses `.toml`), so use a real temp dir.
    let extDir: string;
    let cmdExt: unknown;

    beforeEach(() => {
      extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlh-cmd-ext-'));
      fs.mkdirSync(path.join(extDir, 'commands'), { recursive: true });
      fs.writeFileSync(
        path.join(extDir, 'commands', 'dlh-test.toml'),
        'description = "t"\nprompt = "p"\n',
      );
      cmdExt = {
        name: 'ext-pdf',
        path: extDir,
        config: { name: 'ext-pdf', version: '1.0.0' },
        installMetadata: { source: 'git:pdf-ext', type: 'git' },
      };
    });

    afterEach(() => {
      fs.rmSync(extDir, { recursive: true, force: true });
    });

    it('attributes a .toml extension command', () => {
      expect(
        resolveCommandExtensionInfo(configWith([cmdExt]), 'dlh-test'),
      ).toEqual({ extension_name: 'ext-pdf', extension_source: 'git:pdf-ext' });
    });

    it('returns nulls for a builtin command', () => {
      expect(resolveCommandExtensionInfo(configWith([cmdExt]), 'help')).toEqual(
        { extension_name: null, extension_source: null },
      );
    });
  });

  it('returns nulls when config is undefined', () => {
    expect(resolveSkillExtensionInfo(undefined, 'pdf')).toEqual({
      extension_name: null,
      extension_source: null,
    });
  });
});
