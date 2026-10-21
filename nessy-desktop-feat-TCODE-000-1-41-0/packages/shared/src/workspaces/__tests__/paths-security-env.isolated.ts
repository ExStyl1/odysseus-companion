import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PATH_PROCESSOR_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'agent', 'core', 'path-processor.ts')).href;
const CONFIG_VALIDATOR_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'agent', 'core', 'config-validator.ts')).href;
const PREREQUISITES_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'agent', 'core', 'prerequisite-manager.ts')).href;
const PERMISSIONS_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'agent', 'permissions-config.ts')).href;
const MODE_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'agent', 'mode-manager.ts')).href;
const DOCS_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'docs', 'index.ts')).href;
const LOGO_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'utils', 'logo.ts')).href;
const CONFIG_VALIDATE_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', '..', '..', 'session-tools-core', 'src', 'handlers', 'config-validate.ts')).href;

describe('managed-path security with NESSY_CONFIG_DIR', () => {
  it('uses only the active root for classification, docs, logo, prerequisites, and session-tool validation', () => {
    const configRoot = mkdtempSync(join(tmpdir(), 'nessy-managed-paths-security-'));
    try {
      const workspaceRoot = join(configRoot, 'workspaces', 'active');
      const plansRoot = join(workspaceRoot, 'sessions', 'session-1', 'plans');
      mkdirSync(plansRoot, { recursive: true });
      mkdirSync(join(configRoot, 'docs'), { recursive: true });
      writeFileSync(join(configRoot, 'docs', 'browser-tools.md'), '# Browser tools', 'utf-8');
      writeFileSync(join(configRoot, 'config.json'), JSON.stringify({
        storageLayoutVersion: 2,
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
        browserToolEnabled: true,
      }), 'utf-8');
      writeFileSync(join(configRoot, 'provider-domains.json'), JSON.stringify({
        version: 1,
        domains: { isolated: 'isolated.example' },
        updatedAt: Date.now(),
      }), 'utf-8');

      const oldRoot = join(process.env.HOME ?? '/tmp', '.nessy-agent');
      const result = Bun.spawnSync([process.execPath, '--eval', `
        import { join } from 'node:path';
        import { PathProcessor } from '${PATH_PROCESSOR_MODULE}';
        import { ConfigValidator } from '${CONFIG_VALIDATOR_MODULE}';
        import { PrerequisiteManager } from '${PREREQUISITES_MODULE}';
        import { getAppPermissionsDir } from '${PERMISSIONS_MODULE}';
        import { getPathHint } from '${MODE_MODULE}';
        import { getDocsDir } from '${DOCS_MODULE}';
        import { getProviderDomain } from '${LOGO_MODULE}';
        import { handleConfigValidate } from '${CONFIG_VALIDATE_MODULE}';
        const configRoot = ${JSON.stringify(configRoot)};
        const workspaceRoot = ${JSON.stringify(workspaceRoot)};
        const plansRoot = ${JSON.stringify(plansRoot)};
        const configPath = join(configRoot, 'config.json');
        const oldConfigPath = ${JSON.stringify(join(oldRoot, 'config.json'))};
        const processor = new PathProcessor();
        const validator = new ConfigValidator();
        const prereqs = new PrerequisiteManager({ workspaceRootPath: workspaceRoot });
        const context = {
          configRoot,
          sessionId: 'session-1',
          workspacePath: workspaceRoot,
          get sourcesPath() { return join(workspaceRoot, 'sources'); },
          get skillsPath() { return join(workspaceRoot, 'skills'); },
          plansFolderPath: plansRoot,
          callbacks: { onPlanSubmitted() {}, onAuthRequest() {} },
          fs: {
            exists: () => false,
            readFile: () => '',
            readFileBuffer: () => Buffer.alloc(0),
            writeFile() {},
            isDirectory: () => false,
            readdir: () => [],
            stat: () => ({ size: 0, isDirectory: () => false }),
          },
          loadSourceConfig: () => null,
        };
        const validation = await handleConfigValidate(context, { target: 'config' });
        const legacyWorkspace = join(configRoot, 'workspaces', 'legacy', 'permissions.json');
        const legacySessionPath = join(configRoot, 'workspaces', 'legacy', 'sessions', 'legacy-session', 'plans', 'note.md');
        console.log(JSON.stringify({
          processorActive: processor.isConfigFile(configPath),
          processorOld: processor.isConfigFile(oldConfigPath),
          validatorActive: validator.isNessyAgentConfig(configPath),
          validatorOld: validator.isNessyAgentConfig(oldConfigPath),
          permissions: getAppPermissionsDir(),
          docs: getDocsDir(),
          logo: getProviderDomain('isolated'),
          prerequisite: prereqs.checkPrerequisites('browser_tool').blockReason,
          validation: validation.content[0]?.text,
          legacyHint: getPathHint(legacyWorkspace, plansRoot),
          legacySessionHint: getPathHint(legacySessionPath, plansRoot),
        }));
      `], {
        env: { ...process.env, NESSY_CONFIG_DIR: configRoot },
        stdout: 'pipe',
        stderr: 'pipe',
      });

      expect(result.exitCode).toBe(0);
      const values = JSON.parse(result.stdout.toString());
      expect(values.processorActive).toBe(true);
      expect(values.processorOld).toBe(false);
      expect(values.validatorActive).toBe(true);
      expect(values.validatorOld).toBe(false);
      expect(values.permissions).toBe(join(configRoot, 'permissions'));
      expect(values.docs).toBe(join(configRoot, 'docs'));
      expect(values.logo).toBe('isolated.example');
      expect(values.prerequisite).toContain(join(configRoot, 'docs', 'browser-tools.md'));
      expect(values.validation).toContain('Validation passed');
      expect(values.legacyHint).toContain('Files must be written');
      expect(values.legacySessionHint).toContain('Files must be written');
    } finally {
      rmSync(configRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
