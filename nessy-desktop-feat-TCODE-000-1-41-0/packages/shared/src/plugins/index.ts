export * from './types.ts';
export * from './schema.ts';
export * from './source-resolver.ts';
export * from './declared-components.ts';
export * from './plugin-manifest-probe.ts';
export * from './registry-catalog-fetcher.ts';
// R3: the persisted-registry type is part of the public surface (type-only, so
// it never appears as a RUNTIME export — the W10 public-api guard is unaffected).
// The store CLASS stays off the barrel: the R3 registry source composes it via
// its internal module path and exposes a factory, so no composition root can
// point a store at a path the source gate does not cover. `PluginInstallService`
// — now the V2-owned acquisition pipeline in `acquisition.ts` — is off the barrel
// for the same reason; the factories below are how a composition root reaches it.
export type { PluginMarketplaceRegistry, PluginMarketplaceRegistryFile } from './marketplace-registry-store.ts';
export * from './store-v2.ts';
export * from './bundle-hash.ts';
export * from './adapter-migration.ts';
export * from './data-paths.ts';
export * from './dependencies.ts';
export * from './version-tags.ts';
// `plugins/host-marketplace.md#run-release-channels`'s tag listing. The function, not the
// acquisition CLASS — a composition root needs to hand this one capability to
// `MarketplaceService` without being able to construct its own installer.
export { listRepositoryTags } from './acquisition.ts';
export * from './projection-candidates.ts';
export * from './mcp-credentials.ts';
export * from './mcp-token-refresh.ts';
export * from './management-service-v2.ts';
export * from './management-types.ts';
// D1.69 — session-lifetime plugins. Exported from the package root rather than
// as a new subpath so no `exports` map key is owed for it.
export * from './session-scoped.ts';
export { hasMcpbArchiveExtension, hasRootMcpbManifest, MAX_MCPB_ARCHIVE_BYTES } from './mcpb-archive.ts';
export * from './mcpb-configuration.ts';
// The one reader of configured plugin option values outside the management
// service. The storage classes stay off the barrel — a caller that can construct
// its own store could point it somewhere the source gate does not cover.
export { readPluginOptionEnvironment } from './plugin-settings.ts';
export type { PluginRuntimeDependencyInstaller } from './install-types.ts';
export * from './project-config.ts';
export * from './format-adapters.ts';
export * from './presentation.ts';
export * from './auth-requirements.ts';
export * from './mandated-plugins.ts';
