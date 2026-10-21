# Testing Patterns

**Analysis Date:** 2026-08-16

## Test Framework

**Runner:**
- Bun's built-in test runner (`bun:test`). No Jest/Vitest anywhere.
- Config: `bunfig.toml` (repo root) — the `[test].preload` array is the only global test setup.
- Python smoke tests for the bundled document tools use `unittest` (`apps/electron/resources/scripts/tests/`).

**Assertion Library:**
- `expect` from `bun:test`.

**Run Commands:**
```bash
rm -rf release                  # MANDATORY before a root-level run — see below
bun test                        # whole repo, one process
bun run test                    # bun test + every *.isolated.ts in its own process
bun test packages/shared/src/agent/__tests__/claude-agent.test.ts   # one file
bun run test:shared:all         # the fast focused gate (4 suites)
bun run test:doc-tools          # python doc-tool smokes
bun run typecheck:all           # tsc across every package (see gaps below)
bun run validate:ci             # typecheck:all + test:shared:all + doc tools + i18n + ipc inventory
```

`test:shared:all` (`package.json`) is `test:shared:llm-connections` + `test:shared:models-pi` + `test:shared:config` + `test:shared:codex-adapter`. This is the default focused gate; run the full `bun test` only at a verification-wave boundary (AGENTS.md § *Implementation-First Verification Budget*).

## Non-Negotiable Run Rules

Each of these cost a real wrong measurement (AGENTS.md § *Traps*):

- **`rm -rf release` before `bun test`.** A dmg/AppImage build leaves a packaged copy of the renderer at `release/**/Resources/app/src/`, and the root run collects it: 12 928 tests / 14 phantom failures with `release/` present vs 11 464 / 4 without. Get packaged evidence first, then delete, then run.
- **Never run two `bun test` processes concurrently.** Several session suites mutate `process.env.NESSY_CONFIG_DIR` at module scope and manufacture failures in each other.
- **Before recording a new failure**, check `docs/superpowers/specs/2026-07-29-known-failing-tests.md`, and reproduce on a clean worktree at your base via `git worktree add` (never `git stash`). On a long-lived branch, also compare against the **target** branch — a per-base check cannot see an accumulation.
- **`bun run typecheck:all` is not full coverage**, and the shortfall is a moving number — treat every count here as a dated reading, never a standing fact. It has covered `apps/cli` and `packages/codex-responses-adapter` only since 2026-08-13. The `**/*.test.ts` exclude glob this line described in `packages/pi-agent-server/tsconfig.typecheck.json` was DELETED on 2026-08-28 and replaced by a named list that may only shrink; the old reading — "never typechecks that package's tests, ~429 backlog errors behind the glob" — is kept here only so the direction of travel is legible. **Measured 2026-08-28 via `bun scripts/check-typecheck-coverage.ts --tests`: 14 test files repo-wide are in no typecheck program, all of them `pi-agent-server`'s named exclusions** (71 of its 85 are in the program). That config's own dated comments carry the current error residue; read them rather than a number written here. A green `typecheck:all` is still not evidence that one of those 14 typechecks.
- **`grep`/`rg` silently skips files containing a NUL byte** — several source files here do. Use `grep -a` for any absence claim in a test or audit.

## Test File Organization

**Location:**
- Co-located `__tests__/` directory next to the code — `packages/shared/src/agent/__tests__/`, `packages/server-core/src/sessions/__tests__/`, `apps/electron/src/renderer/components/app-shell/__tests__/`.
- A few package-level suites live in `packages/shared/tests/` (the ones wired into `test:shared:*` scripts).
- ~1 180 test files repo-wide; the density centres on `packages/shared/src/agent` (165 files), `packages/shared/src/config` (69), `packages/server-core/src/sessions` (59), `packages/shared/src/plugins` (50).

**Naming:**
- `<subject>.test.ts` / `.test.tsx` for in-process tests.
- `<subject>.isolated.ts` for tests that MUST own their process (env frozen at import, global mocks that cannot be undone). Examples: `packages/shared/src/config/__tests__/retention-failsafe.isolated.ts`, `packages/shared/src/workspaces/__tests__/paths-env.isolated.ts`, `apps/electron/src/main/__tests__/notifications-routing.isolated.ts`. `bun test` does **not** pick these up — only `bun run test` does, one process each.

**Structure:**
```
packages/shared/src/agent/
├── claude-runtime-agents.ts
└── __tests__/
    ├── claude-gateway-adapter.test.ts
    ├── permission-mode-runtime-translations.test.ts
    └── fixtures/
```

## Test Structure

**Suite Organization:**
```typescript
/**
 * R5 — one mode vocabulary, three honest translations.
 *
 * ## The decision this suite guards
 * ...
 * ## What this suite can and cannot prove
 * Neither the `claude` native binary nor `codex-app-server` runs here, so what
 * is proven is that the OPTION each runtime is handed is the one its table says.
 */
import { afterAll, describe, expect, it } from 'bun:test';

describe('permission mode translations', () => {
  it('does not widen the Claude table', () => { … });
});
```

**Patterns:**
- **Every suite opens with a header comment** naming the plan/task id, the decision it guards, and — critically — *what it cannot prove*. This is the strongest convention in the repo's tests; reproduce it.
- `describe` + `it` in `packages/shared`; `describe` + `test` appears in renderer suites (`AgentPanel.test.tsx`). Both are accepted — match the file.
- Table-driven rows over duplicated cases: one row per mode covering all three runtimes.
- Cross-runtime "drift checks" assert that a hand-copied constant still equals its shared original.

## Mocking

**Framework:** `mock` / `mock.module` from `bun:test`.

**The `mock.module` contract — read before writing one:**
`mock.module` is **process-global** and `bun test` runs every file in one process. A replacement listing only the exports one file needs un-implements every *other* export of that module for every test file that loads afterwards (and `packages/server-core` sorts before `packages/shared`, so the stub is installed first in a full run). This produced a green-alone / red-in-CI failure that pointed at the wrong subsystem for four rounds.

**Required pattern** (`packages/shared/src/agent/__tests__/claude-gateway-adapter.test.ts:44`):
```typescript
const realStorage = { ...configStorage };

mock.module('../../config/storage.ts', () => ({
  ...realStorage,                      // 1. spread the REAL module
  getLlmConnection: (slug: string) => ( // 2. override, delegating outside your fixtures
    storedConnection && slug === storedConnection.slug
      ? storedConnection
      : realStorage.getLlmConnection(slug)
  ),
}));

afterAll(() => {                        // 3. ALWAYS restore
  mock.module('../../config/storage.ts', () => realStorage);
});
```
Then import the code under test **after** the mocks: `const { ClaudeAgent } = await import('../claude-agent.ts');`

- The spread alone is not sufficient when the override is the point — delegate to the real implementation for inputs your fixtures do not own, and restore in `afterAll`.
- If you cannot make a mock reversible, the test belongs in a `.isolated.ts` file.
- Debugging a suspected stub leak: print the installed function's own source (`String(mod.getMemoryEnabled)`), do not reason statically.

**Global preloads** (`bunfig.toml` `[test].preload`, order is load-bearing):
1. `packages/shared/tests/setup/isolate-shared-config-dir.ts` — points `NESSY_CONFIG_DIR` at a per-run temp dir and seeds it, **before** anything can freeze `CONFIG_DIR` at the developer's real `~/.nessy-agent`. Must stay first.
2. `packages/shared/src/unified-network-interceptor.ts`.
3. `apps/electron/testing/electron-mock-preload.ts` — stubs the `electron` module (own enumerable keys, not a bare Proxy) so main-process suites collect on CI runners without the native binary. A file needing specific behaviour declares its own `mock.module('electron', …)`, which overrides the baseline for that file.

**What to Mock:**
- Module seams at the process boundary: stored config (`config/storage.ts`), the credential store (`credentials/index.ts`), adapter launchers (`@nessy-agent/codex-responses-adapter`), `electron`.
- Anything that would open a socket, read `~/.nessy/dp_auth_creds.json`, or spawn a provider binary. Suites must be hermetic.

**What NOT to Mock:**
- The translation/table code under test — assert on the option handed to the runtime instead.
- Provider binaries: behaviour of `claude` or `codex-app-server` belongs to a live case, not a unit test.

## Fixtures and Factories

**Test Data:**
```typescript
function connection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return { slug: 'nessy-claude', name: 'Nessy Claude', …, ...overrides };
}

const GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';
/** Same host, different path — AGENTS.md: this must NOT get Nestor semantics. */
const SAME_HOST_OTHER_PATH = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/other/v1';
```
- Builder function with a `Partial<T>` overrides argument, plus named constants whose comment states the invariant they exercise.

**Location:**
- File-local under a `// ==== Fixtures ====` banner, or shared under `__tests__/fixtures/` (`packages/shared/src/agent/__tests__/fixtures`, `packages/shared/src/plugins/__tests__/fixtures`, `packages/shared/src/mcp/__tests__/fixtures`, `packages/pi-agent-server/src/__tests__/harness-contract/fixtures`).
- Filesystem fixtures use `mkdtempSync(join(tmpdir(), …))` and clean up with `rmSync`.

## Coverage

**Requirements:** None enforced — no coverage threshold, no coverage job in `validate:ci`.

**The policy instead** (AGENTS.md § *Implementation-First Verification Budget*): add the **minimum non-duplicative** tests proving each new invariant — normally one representative positive path and one negative/boundary path, table-driven where useful. Do not multiply equivalent tests or add speculative edge cases already covered by a lower-level contract.

**View Coverage:**
```bash
bun test --coverage    # available from the runner; not wired into any script or gate
```

## Test Types

**Unit / contract tests:** The bulk. Hermetic, in-process, module seams faked. They prove the option/payload a boundary is handed, plus no-widening and drift invariants on shared tables.

**Isolated tests:** `*.isolated.ts`, one process each via `bun run test`. For env frozen at import time and irreversible global mocks.

**Renderer tests:** `.test.tsx` under `apps/electron/src/renderer/**/__tests__/`. No DOM library — they render with `renderToStaticMarkup` from `react-dom/server` and wrap in a locally-built i18next instance (`createInstance()` + `I18nextProvider`) with an inline `translations` map. Pure-logic helpers are exported from the component file and asserted directly (`agentPanelKeyAction`, `toAgentPanelRows` in `AgentPanel.test.tsx`).

**Python smoke tests:** `bun run test:doc-tools` — `unittest` smokes for the bundled pdf/xlsx/docx/pptx/img/ical/diff/markitdown tools.

**Live / E2E:** Not a test suite. Live cases live in `docs/testing/cdp-live-checklist.md`, driven by `scripts/cdp/`. Rules: force dark theme for any visual capture; live evidence must come from a **packaged** build (`electron:dev` runs the main process and Pi subprocess from built bundles, and a missing interceptor bundle starts Pi unpatched with no error).

## Common Patterns

**Async Testing:**
```typescript
it('starts the adapter on a loopback port', async () => {
  const handle = await agent.postInit();
  expect(adapterStarts).toHaveLength(1);
});
```

**Error Testing:**
```typescript
expect(() => loadStoredConfig()).toThrow(UnsupportedStorageLayoutError);
await expect(startAdapter({})).rejects.toThrow();
```

**Proving an absence:** a finding that "X never happens" needs a positive control on the same rig, and must be confirmed against a source the feature writes itself (e.g. the session's own `.pi-sessions/*.jsonl`) — a typed-but-never-filled field reported "never compacted" through 27 real compactions. Size any threshold knob against the system's resting state (a session's base context is ~46 000 tokens), never against zero.

---

*Testing analysis: 2026-08-16*
