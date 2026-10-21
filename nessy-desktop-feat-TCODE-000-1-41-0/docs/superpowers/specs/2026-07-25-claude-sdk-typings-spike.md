# Claude Agent SDK typings spike — result

The parity audit made this a hard precondition: every "pass this SDK option"
recommendation in it was read out of Claude's docs and **none** had been checked
against the installed typings. This is that check. It is done; the plans it gates
may proceed.

**Installed version: `@anthropic-ai/claude-agent-sdk` `0.3.183`**, pinned
identically in root `package.json:133`, `packages/shared/package.json:129` and
`packages/core/package.json:15`, resolved at
`node_modules/@anthropic-ai/claude-agent-sdk` with the native sidecar
`@anthropic-ai/claude-agent-sdk-darwin-arm64`.

**Method.** A probe `.ts` importing `Options`, `SDKResultMessage`,
`RewindFilesResult`, `SettingSource` and `query`, compiled with the repo's own
`node_modules/.bin/tsc` (strict, ES2022, `moduleResolution bundler`, `noEmit`,
`skipLibCheck`) against the real `node_modules`. Pass 1 wrapped every
expected-absent name in `@ts-expect-error` and exited 0 — which proves both that
the accepted keys compile **and** that each directive was consumed, since an
unused `@ts-expect-error` is itself an error. Pass 2 stripped the directives and
produced the verbatim errors. Verdicts below are compiler output, not reading.

## Verdicts

| Option | Verdict |
| --- | --- |
| `maxTurns` | **ACCEPTED** |
| `maxBudgetUsd` | **ACCEPTED** |
| `outputFormat` | **ACCEPTED** |
| `enableFileCheckpointing` | **ACCEPTED** |
| `resumeSessionAt` | **ACCEPTED** |
| `settingSources` | **ACCEPTED** |
| `sandbox` | **ACCEPTED** — but its type is loose, so TypeScript will **not** catch a typo'd key inside it. Validate the shape ourselves. |
| `rewindFiles` | **ABSENT as an option.** It is a method on the query handle: `Query.rewindFiles()`. |
| `excludeDynamicSections` | **ABSENT at top level.** It nests **inside** `Options.systemPrompt`. |

Two of the nine audit recommendations were therefore wrong in shape. A plan that
had added them as options would not have compiled.

## The two corrections, precisely

**`rewindFiles`** is called on the stored query handle, which already exists:
`claude-agent.ts:1588`/`:1594`/`:1598` assign
`this.currentQuery = query({ prompt, options })`, and `claude-agent.ts:1622` only
ever iterates it — no method on it is invoked today. The call site is
`await this.currentQuery.rewindFiles(userMessageId, { dryRun: true })` from a new
method on `ClaudeAgent`, not a key in any options object.

**`excludeDynamicSections`** goes inside the preset object we already build at
`claude-agent.ts:1148-1168`:

```ts
systemPrompt: miniConfig.enabled
  ? this.getMiniSystemPrompt()
  : { type: 'preset' as const, preset: 'claude_code' as const, append: getSystemPrompt(…) },
```

It is a sibling of `type` / `preset` / `append`, and it is a **no-op on the
`miniConfig.enabled` branch**, which returns a plain string prompt.

## Termination surface

`subtype`, `num_turns` and `stop_reason` all **exist** on the result message, in
**snake_case only** — `numTurns` and `stopReason` are ABSENT.

We read almost none of it. `backend/claude/event-adapter.ts:463` does
`const msg = message as any`, which defeats the union entirely, and then reads only
`msg.subtype`, `msg.errors`, `msg.modelUsage`, `msg.usage` and
`msg.total_cost_usd`. Every non-success subtype collapses into one error string at
`:507`, which is why a turn cap, a budget cap and a crash are indistinguishable
downstream. Narrowing that `as any` to `SDKResultMessage` and branching per
`subtype` value — `'error_max_turns'`, `'error_max_budget_usd'`,
`'error_max_structured_output_retries'` — is the whole of the terminal-reason fix
on the Claude side.

## What this unblocks

Audit shortlist items 3, 4 and 5 (terminal-reason wire, Claude-backend option
wiring, rewind and checkpoint correctness) were blocked on this spike. They are
unblocked, with the two shape corrections above mandatory.

Still unverified and still blocking its own item: the Pi SDK bump. The audit's
`0.82.x` figure is unconfirmed — see the correction attached to the P0U note in
the audit.
