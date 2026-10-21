/**
 * DA2.20 — the environment-variable NAMES a provider credential travels under
 * on this product, as one exported list instead of a prose enumeration.
 *
 * ## Why this is not `BLOCKED_ENV_VARS`
 *
 * `BLOCKED_ENV_VARS` (`packages/session-tools-core/src/runtime/sandbox-env.ts`,
 * and a second copy in `packages/shared/src/mcp/client.ts`) answers a different
 * question: **any credential worth stripping from a subprocess this host
 * spawns** — so it carries `GITHUB_TOKEN`, `STRIPE_SECRET_KEY`, `NPM_TOKEN`,
 * the three `AWS_*` and `GOOGLE_API_KEY`, none of which this product ever
 * writes. This list answers **which names a provider key of ours can be read
 * back under**, so it carries names that list does not and must not contain
 * `NPM_TOKEN`.
 *
 * Neither is a subset of the other, measured 2026-09-17 over the eleven-name
 * blocked list and the six names `scripts/cdp/cases/rs-16.ts` used to retype:
 * they share exactly two (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), the case
 * carried four the blocked list lacks and the blocked list carries NINE the case
 * did not probe. **One of those nine is `CLAUDE_CODE_OAUTH_TOKEN`** — the name
 * `resolveAuthEnvVars` (`packages/shared/src/config/llm-connections.ts`) writes
 * a real OAuth access token into for an `oauth` connection — so the probe that
 * asked whether an agent's own shell can read a provider key was not asking
 * about one of the two names this product writes a live credential under. That
 * is the absence that looks like a pass, and it is why this list exists rather
 * than a merge of the two.
 *
 * ## Provenance, per name (measured 2026-09-17 at `6dd16c921`)
 *
 * Read from the production modules rather than assumed; the grep is
 * `git grep -an <name> -- packages apps` with the test trees excluded.
 *
 * - `ANTHROPIC_API_KEY` — **written with the connection's real key** by
 *   `resolveAuthEnvVars` for `api_key` / `api_key_with_endpoint` /
 *   `bearer_token`, and by `agent/backend/factory.ts`. The claude-runtime
 *   adapter path writes the ten-character placeholder `not-needed` here
 *   instead (`agent/claude-agent.ts`, `startLocalAdapterRuntime`), which is the
 *   distinction DA2.13 measured as a character count.
 * - `CLAUDE_CODE_OAUTH_TOKEN` — **written with a real OAuth access token** by
 *   the same function's `oauth` branch, for both the Anthropic and the
 *   connection-scoped store.
 * - `COMPANY_LLM_API_KEY` — the value of `CODEX_API_KEY_ENV`
 *   (`packages/codex-responses-adapter/src/config-writer.ts`), which the writer
 *   emits as codex's own `env_key` and `agent/codex-agent.ts` fills with the
 *   placeholder `loopback`. Codex reads its credential from whatever name that
 *   constant holds, so a probe that spells `CODEX_API_KEY` asks about a name
 *   this product has never written.
 * - `ANTHROPIC_AUTH_TOKEN` — never written by us and deliberately DELETED
 *   before a claude child starts (`agent/claude-agent.ts`), because it is the
 *   SDK's own precedence tier 2. An ambient one surviving into the child is
 *   exactly the leak this list is probed for, so the name stays.
 * - `OPENAI_API_KEY`, `NESTOR_TOKEN`, `CODEX_API_KEY`, `PI_API_KEY` — probed
 *   since RS-16 was written and **written by no module in `packages` or `apps`**
 *   (`NESTOR_TOKEN` and `PI_API_KEY` score zero occurrences outside test trees;
 *   `NESTOR_TOKEN` is an HTTP HEADER name, `Nestor-Token`, and never an
 *   environment variable). They are kept because absence here is the finding:
 *   each is a name an operator environment or a third-party runtime can carry,
 *   and a probe that stopped asking would stop being able to say so.
 *
 * ## What this list deliberately does NOT carry
 *
 * `NESSY_CODEX_MCP_POOL_TOKEN` (`CODEX_POOL_MCP_TOKEN_ENV`) is a bearer this
 * host really does write into a codex child's environment, and it is not here:
 * it is a POOL token for our own loopback listener, not a provider key, and the
 * question this list serves is the provider one. Named rather than omitted, so
 * the next reader knows it was weighed.
 *
 * The relationship above is recorded here and NOT asserted in the sibling test,
 * with the reason: DA2.22 is moving `BLOCKED_ENV_VARS` into a single export, and
 * a guard that reddens because a sibling row landed is a guard the next reader
 * learns to ignore. The reading is dated; when that export exists the assertion
 * is cheap and safe to add.
 *
 * ## Adding a name
 *
 * If this product starts writing a provider credential under a new name, add it
 * here with its provenance sentence. A name added to `BLOCKED_ENV_VARS` does NOT
 * automatically belong here, and vice versa — that is the whole point of the two
 * lists.
 */
export const PROVIDER_KEY_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'COMPANY_LLM_API_KEY',
  'OPENAI_API_KEY',
  'NESTOR_TOKEN',
  'CODEX_API_KEY',
  'PI_API_KEY',
] as const

export type ProviderKeyEnvName = (typeof PROVIDER_KEY_ENV_NAMES)[number]

/**
 * The subset this product WRITES into a model child's environment today.
 *
 * Separate from the list above because the two carry different obligations: a
 * name here that a child's shell can read is a reading about OUR wiring, and a
 * name only in the list above that a child can read arrived from somewhere else.
 * `scripts/cdp/cases/rs-16.ts` probes the union and classifies with this.
 *
 * `ANTHROPIC_AUTH_TOKEN` is NOT here: the host deletes it rather than writing
 * it. `COMPANY_LLM_API_KEY` IS, even though the value written is the placeholder
 * `loopback` — the obligation is about the name being ours, and the character
 * count is what separates a placeholder from a credential.
 */
export const PRODUCT_WRITTEN_PROVIDER_KEY_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'COMPANY_LLM_API_KEY',
] as const satisfies readonly ProviderKeyEnvName[]
