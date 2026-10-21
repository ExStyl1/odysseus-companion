import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pluginApi from '../index.ts';

it('exposes only the v2 plugin runtime mutation surface after W10', () => {
  const exportedNames = new Set(Object.keys(pluginApi));
  const retiredRuntimeNames = [
    'PluginStore',
    'PluginInstallService',
    'PluginHookRuntime',
    'PluginScopedAutomationSystem',
    'buildPluginMcpServerConfig',
    'buildTrustedPluginHookAutomations',
    'commitInstall',
    'createHookRegistryFromProjection',
    'createInstallPlanFromSource',
    'getDefaultPluginStoreRoot',
    'loadPluginSkillsFromProjection',
    'normalizeStagedInstall',
    'parseHookOutput',
    'pluginHookExecutableHash',
    'projectPluginRuntime',
    'removePluginRuntimeProjection',
    'resolveRuntimeHookSources',
    'resolveRuntimeMcpVisibility',
    'resolvePluginProjectionPlan',
    'runHooks',
    'stageInstall',
  ];

  expect(retiredRuntimeNames.filter(name => exportedNames.has(name))).toEqual([]);
  expect(exportedNames.has('PluginStoreV2')).toBe(true);
  expect(exportedNames.has('PluginManagementServiceV2')).toBe(true);
});

it('exposes the A10 unified-adapter runtime surface: createPluginCapabilityId is a callable export, and no retired name reappeared', () => {
  const exportedNames = new Set(Object.keys(pluginApi));

  // createPluginCapabilityId (schema.ts) is a real runtime function re-exported
  // through `export * from './schema.ts'` in index.ts — assert it is present
  // AND callable, not just a key on the module namespace.
  expect(exportedNames.has('createPluginCapabilityId')).toBe(true);
  expect(typeof (pluginApi as unknown as { createPluginCapabilityId: unknown }).createPluginCapabilityId).toBe('function');
  expect((pluginApi as unknown as { createPluginCapabilityId: (kind: string, id: string) => string })
    .createPluginCapabilityId('skill', 'demo')).toBe('skill.demo');

  // The A2 IR types (PluginCompatibilityReport, PluginRuntimeCompatibilityProfile,
  // PluginEcosystemFormat, PluginBundleNormalizationResult, PluginAgentDescriptor,
  // PluginPromptCommandDescriptor, PluginUnsupportedDescriptor, etc.) are
  // TypeScript type-only declarations (`export interface` / `export type`) in
  // types.ts. TS type erasure means they NEVER appear as runtime keys on the
  // compiled JS module object, regardless of whether index.ts re-exports them
  // via `export * from './types.ts'` or a named `export type` — so asserting
  // their presence via `Object.keys(pluginApi)` would be dishonest (it can
  // only ever be false, or coincidentally true for an unrelated runtime name).
  // Instead, verify their SOURCE-LEVEL presence: index.ts re-exports the whole
  // types.ts module (barrel `export *`), and types.ts itself declares each name
  // as a real exported type — this is the correct, honest way to assert an A2
  // IR type is part of the public surface without a false runtime claim.
  const indexSource = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf-8');
  expect(indexSource).toMatch(/export \* from '\.\/types\.ts';/);
  const typesSource = readFileSync(join(import.meta.dir, '..', 'types.ts'), 'utf-8');
  for (const typeName of [
    'PluginCompatibilityReport',
    'PluginRuntimeCompatibilityProfile',
    'PluginRuntimeCompatibility',
    'PluginEcosystemFormat',
    'PluginCompatibilityState',
    'PluginBundleNormalizationResult',
    'PluginAgentDescriptor',
    'PluginPromptCommandDescriptor',
    'PluginUnsupportedDescriptor',
  ]) {
    expect(typesSource).toMatch(new RegExp(`export (type|interface) ${typeName}\\b`));
  }

  // No retired runtime name reappeared (re-assert the same list this file's
  // first test already guards, so this test is independently meaningful).
  const retiredRuntimeNames = [
    'PluginStore',
    'PluginInstallService',
    'PluginHookRuntime',
    'PluginScopedAutomationSystem',
    'buildPluginMcpServerConfig',
    'buildTrustedPluginHookAutomations',
    'commitInstall',
    'createHookRegistryFromProjection',
    'createInstallPlanFromSource',
    'getDefaultPluginStoreRoot',
    'loadPluginSkillsFromProjection',
    'normalizeStagedInstall',
    'parseHookOutput',
    'pluginHookExecutableHash',
    'projectPluginRuntime',
    'removePluginRuntimeProjection',
    'resolveRuntimeHookSources',
    'resolveRuntimeMcpVisibility',
    'resolvePluginProjectionPlan',
    'runHooks',
    'stageInstall',
  ];
  expect(retiredRuntimeNames.filter(name => exportedNames.has(name))).toEqual([]);
});
