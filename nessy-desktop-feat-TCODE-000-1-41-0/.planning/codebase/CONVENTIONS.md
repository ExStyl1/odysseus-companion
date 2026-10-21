# Coding Conventions

**Analysis Date:** 2026-08-16

## Naming Patterns

**Files:**
- Non-renderer TypeScript (`packages/**/src`, `apps/electron/src/main`): `kebab-case.ts` — `packages/shared/src/agent/claude-runtime-agents.ts`, `packages/shared/src/config/storage.ts`, `packages/codex-responses-adapter/src/config-writer.ts`.
- React components: `PascalCase.tsx` — `apps/electron/src/renderer/components/app-shell/AgentPanel.tsx`, `GatewayAuthBanner.tsx`.
- Component-adjacent logic split out of a component keeps the component's stem plus a dotted suffix: `ChatDisplay.follow-ups.ts`, `ChatDisplay.usage-format.ts`.
- Tests: `<subject>.test.ts` / `.test.tsx`, in a sibling `__tests__/` directory. Subprocess-isolated tests use `.isolated.ts` (see TESTING.md).
- Custom ESLint rules are CommonJS: `apps/electron/eslint-rules/no-localstorage.cjs`.

**Functions:**
- `camelCase`, verb-first, and named for the contract they satisfy: `materializePiRuntimeAgentDefinitions`, `toClaudeSdkPermissionMode`, `buildClaudeSubprocessEnv`, `isAnthropicBackendEnabled` (`packages/shared/src/feature-flags.ts`).
- Boolean predicates start `is`/`has`/`should`: `isSourceUsable`, `shouldAllowToolInMode` (`packages/shared/src/agent/mode-manager.ts`).
- React components are `PascalCase` function components; hooks are `useX` — `useNessyGatewayAuth` (`apps/electron/src/renderer/hooks/useNessyGatewayAuth.ts`).

**Variables:**
- `camelCase` locals; module-level immutable tables and enum-ish sets are `SCREAMING_SNAKE_CASE`: `SDK_PERMISSION_MODES`, `CLAUDE_SDK_PERMISSION_MODE_TABLE`, `CODEX_PERMISSION_MODE_ORDER`, `GATEWAY_BASE_URL`.
- Env vars are `NESSY_*` — `NESSY_CONFIG_DIR`, `NESSY_DEBUG`, `NESSY_FEATURE_*` (`packages/shared/src/feature-flags.ts`).
- Numeric literals use `_` separators where large: `262_144`.

**Types:**
- `PascalCase` interfaces/type aliases, no `I` prefix: `LlmConnection`, `AdapterHandle`, `PiRuntimeAgentDefinitionDescriptor`, `PermissionMode`.
- Union string literals over enums (`type PermissionMode = 'default' | …` in `packages/shared/src/agent/mode-types.ts`).

## Code Style

**Formatting:**
- No Prettier, no repo formatter config. Style is per-surface and enforced by review, not tooling.
- Indent 2 spaces, single quotes, trailing commas in multi-line literals — universal.
- **Semicolons split by surface:** `packages/**` and `apps/electron/src/main` use semicolons (`packages/shared/src/agent/claude-runtime-agents.ts`); renderer `.tsx` under `apps/electron/src/renderer` omits them (`GatewayAuthBanner.tsx`). Match the file you are editing.

**Linting:**
- ESLint 9 flat config, one per surface: `apps/electron/eslint.config.mjs`, `packages/shared/eslint.config.mjs`, `packages/ui/eslint.config.mjs`. Run `bun run lint` (all three) or `bun run lint:electron|lint:shared|lint:ui`.
- The repo's real convention enforcement is a set of **custom rules**, not stylistic ones. Treat each as a mandatory API:

| Rule | Where | Requirement |
|------|-------|-------------|
| `nessy-shared/no-direct-open-import` | `packages/shared/eslint-rules/no-direct-open-import.cjs` | Never `import 'open'`; use `openUrl()` from shared utils |
| `nessy-shared/no-inline-source-auth-check` | shared + electron | Never test `source.config.isAuthenticated` inline; call `isSourceUsable()` |
| `nessy-general-agent/no-direct-navigation-state` | `apps/electron/eslint-rules/no-direct-navigation-state.cjs` | Route through `navigate()`, never mutate navigation state |
| `nessy-general-agent/no-localstorage` (warn) | electron | Do not use `localStorage` in the renderer |
| `nessy-platform/no-direct-platform-check` | electron | Use the platform helper, not `process.platform` comparisons |
| `nessy-paths/no-hardcoded-path-separator` (warn) | electron | No literal `/` or `\` joins; use path helpers |
| `nessy-links/no-direct-file-open` | electron | File opens must go through the in-app preview interceptor |
| `nessy-styles/no-hardcoded-z-index` | electron + ui | Use the z-index token scale |
| `nessy-styles/no-nonstandard-shadows` | electron + ui | Only the allow-listed `shadow-*` classes |
| `no-restricted-imports` (react-hotkeys-hook) | electron | Use `useAction` from `@/actions` |

- **Architecture boundaries are lint-enforced.** `apps/electron/src/main/**` may not import `@nessy-agent/shared/codex`, `.../agent/claude-agent`, or `.../agent/pi-agent` — go through `@nessy-agent/shared/agent/backend`. `apps/electron/src/main/model-fetchers/**` may not call `fetch` or import `@anthropic-ai/claude-agent-sdk` / `@earendil-works/pi-ai`; provider SDK usage lives only in `packages/shared/src/agent/backend/internal/drivers/`.
- Custom rules have their own tests (`apps/electron/eslint-rules/__tests__/`, `packages/ui/eslint-rules/__tests__/`). Add one when you add a rule.

**TypeScript:**
- `tsconfig.base.json` is strict and adds `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `allowImportingTsExtensions`. `noUnusedLocals`/`noUnusedParameters` are **off**.
- `verbatimModuleSyntax` means type-only imports must be written `import type { X } from …` or `import { type X, fn }`.

## Import Organization

**Order:**
1. Node builtins with the `node:` prefix — `import { mkdtempSync } from 'node:fs'`.
2. External packages — `@anthropic-ai/claude-agent-sdk`, `react`, `bun:test`.
3. Workspace packages — `@nessy-agent/core/types`, `@nessy-agent/shared/agent/backend`, `@nessy-agent/codex-responses-adapter/config-writer`.
4. Local relative imports, **with the `.ts`/`.tsx` extension** — `from './pi-harness/runtime-agent-definition.ts'`.

**Path Aliases:**
- Renderer: `@/` → `apps/electron/src/renderer` (`import { Button } from '@/components/ui/button'`).
- Cross-package: the `@nessy-agent/*` workspace scope with deep subpath exports.
- Relative imports inside a package must carry the file extension; renderer `.tsx` imports of components omit it (`from '../AgentPanel'`).

## Error Handling

**Patterns:**
- Fail closed on trust boundaries: config loading throws `UnsupportedStorageLayoutError` on a legacy/corrupt layout rather than silently returning `null` (`packages/shared/src/config/storage.ts`).
- Validate at the wire parse, not at every consumer. `parsePiRuntimeAgentDefinitions` rejects empty prompts, `maxTurns < 1`, and out-of-set enums, so downstream builders (`claude-runtime-agents.ts`) carry no per-field guard — a new field must get its guard at the parse site or it reintroduces an all-or-nothing failure.
- When translating to a foreign runtime schema, **omit an unrepresentable value rather than coerce it** (`'explore'` mode and `'off'` effort are dropped, not mapped to a neighbour).
- Async teardown is explicit: handles expose `close(): Promise<void>` and die with the session (`AdapterHandle`).

## Logging

**Framework:** No logger package. `console.*` gated by a debug helper.

**Patterns:**
- Debug output is env-gated at module load: `packages/shared/src/utils/debug.ts`, `NESSY_DEBUG=1` / `--debug` (`packages/shared/src/interceptor-common.ts:27`), plus narrow knobs like `NESSY_DEBUG_SSE_RAW`.
- `isDevMode()` in `packages/shared/src/feature-flags.ts` is the dev/debug predicate; do not re-derive it from `NODE_ENV`.
- Never log credentials or the JWT from `~/.nessy/dp_auth_creds.json`.

## Comments

**When to Comment:**
- This repo's dominant convention: **a file-header block comment stating the contract, the source it was read from, and the decision it encodes.** See the 55-line header of `packages/shared/src/agent/claude-runtime-agents.ts` and the header of `apps/electron/testing/electron-mock-preload.ts`.
- Cite external contracts by **quoted sentence plus page**, not by line number alone (line numbers decay — an AGENTS.md trap). Cite installed typings separately from the doc page; never let one stand in for the other.
- A deliberate omission gets a comment saying it is deliberate and why (see the "Deliberately NOT forwarded" section in `claude-runtime-agents.ts`).

**JSDoc/TSDoc:**
- `/** … */` on exported functions, constant tables, and types, explaining the *reason*, not the signature. Cross-reference with `{@link X}`.

## Function Design

**Size:** Small and single-purpose; heavy explanation lives in the doc comment, not in inline branching.

**Parameters:** Object-literal options for anything past two arguments (`startAdapter({ upstream })`); `Partial<T>`-overrides helpers for fixtures.

**Return Values:** Prefer total, lossless translation functions over stateful builders. Readonly types (`ReadonlySet`, `as const` tables) for lookup data.

## Module Design

**Exports:** Named exports only; no default exports outside ESLint rule files (`module.exports` in `.cjs`) and React entry points.

**Barrel Files:** `packages/shared/src/index.ts` exists, but consumers import deep subpaths (`@nessy-agent/shared/agent/backend`) so the lint boundary rules can name them. Prefer the deep path.

**Boundaries:** Prefer existing package boundaries and helper APIs. Provider SDKs stay behind `packages/shared/src/agent/backend/`; the renderer never talks to a provider directly.

## i18n

- All user-facing strings go through `useTranslation()` / `t('namespace.key')` (`react-i18next`) — `apps/electron/src/renderer/components/app-shell/GatewayAuthBanner.tsx:69`.
- A new key must be added to **every** locale file, and the files must stay sorted. Gates: `bun run lint:i18n:parity`, `bun run lint:i18n:sorted` (`bun run sort-locales` fixes ordering).

---

*Convention analysis: 2026-08-16*
