export * from './types.ts';
export * from './llm-connections.ts';
export * from './llm-validation.ts';
export * from './models.ts';
export * from './models-pi.ts';
export * from './context-window-resolver.ts';
export * from './model-fetcher.ts';
export * from './preferences.ts';
export * from './paths.ts';
export * from './sandbox-settings.ts';
export * from './worktree-settings.ts';
// P6.361 — the saved-actions store. Exported here for the same reason
// `worktree-settings` is: the entry point that lists and runs them lives in
// server-core, and the type has to cross the package boundary with it.
export * from './workspace-actions.ts';
export * from './workflow-settings.ts';
export * from './safe-mode.ts';
export * from './subagent-model.ts';
export * from './bundled-skills-settings.ts';
export * from './skill-overrides.ts';
export * from './print-background-wait.ts';
export * from './network-address-guard.ts';
export * from './proxy-env.ts';
export * from './proxy-url-validation.ts';
export * from './tls-ca-path.ts';
export * from './auto-compaction-settings.ts';
export * from './source-startup-settings.ts';
export * from './builtin-dp-mcp-settings.ts';
export * from './builtin-dp-mcp-preferences.ts';
export * from './managed-env.ts';
export * from './managed-approval.ts';
export * from './managed-delivery.ts';
export * from './managed-refresh-gate.ts';
export * from './managed-in-app-updates.ts';
// P6.537 — the operator's model price table. In the barrel beside the other
// managed readers, and safe there for the same reason they are: the module has
// ZERO imports, so the Vite renderer bundle picks up no transitive `node:` one.
export * from './managed-model-prices.ts';
export * from './managed-in-app-browser.ts';
// D1.205 — the codex `in_app_local_automation` tier. In the barrel beside its
// siblings and safe there for their reason: the module has ZERO imports, so the
// Vite renderer bundle picks up no transitive `node:` edge.
export * from './managed-local-automation.ts';
export * from './notification-timing.ts';
// P6.821 — the two budget-ceiling resolvers. In the barrel rather than in a
// subpath of their own because the module's only import is `./storage.ts`,
// which the line below already exports, so this adds no transitive edge — and
// because the ceilings now have a THIRD reader beside the two agent ones: the
// `SETTINGS_GET` disclosure in server-core, which must not compute them itself.
// D1.118 — the foreign-remedy detector, exported through the BARREL rather than
// as its own subpath: `packages/shared/package.json` publishes no `./config/*`
// pattern, so a new subpath import would owe an exports-map key in the same
// commit (AGENTS.md wave-9 rule 26) and `package.json` is a file no lane edits.
export * from './gateway-model-refusal.ts';
export * from './max-budget-tokens.ts';
export * from './storage.ts';
// C3.178 — the primary-folder choice's pure resolver, beside the reader/setter
// `storage.ts` owns. Type-only and path-only: no filesystem read of its own.
export * from './primary-directory.ts';
export * from './theme.ts';
export * from './theme-roles.ts'; // UB13.3 — the solver, exported for tests that compute roles (UB13.8's control)
export * from './validators.ts';
export {
  ConfigWatcher,
  createConfigWatcher,
  type ConfigWatcherCallbacks,
} from './watcher.ts';
