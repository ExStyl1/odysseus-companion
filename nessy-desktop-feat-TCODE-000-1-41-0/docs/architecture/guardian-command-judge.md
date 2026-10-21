# Guardian command judge

The guardian is an LLM safety judge that reviews borderline and high-risk tool
executions in Nessy Desktop's autonomous permission modes. It reduces approval
fatigue in `auto` mode and adds a deny-only safety net in `allow-all` mode. It
is modelled on the pattern both Codex (guardian `policy.md` + `auto_review`) and
Cursor (auto-review security classifier) ship.

## Authority contract

The deterministic `permission-service` remains the ONLY permission authority.
The guardian is a CONSULTED INPUT that the mode's rules explicitly delegate to
for a defined band of decisions. Its verdict is folded into the
`PiPermissionPolicyDecision` BEFORE `authorizeAndSend`, so every allow/deny
still mints a receipt (the audit record) through `permissionService.authorize`.

The guardian can never grant anything the mode's rules would not already allow.
It only converts a "would ask" into allow/deny inside the delegated band, or a
"would run" into deny/ask in the safety-net band:

| Mode | Guardian role |
| --- | --- |
| `auto` | Borderline band: the exact set that ASKS today consults the judge. `no_objection` → run; `deny` → block; `unsure`/error/timeout → ask. |
| `allow-all` | Deny-only net on high-risk actions. `no_objection` → run; `deny` → block; `unsure`/error/timeout → downgrade to ask. Everything else runs unchanged. |
| `safe` / `plan` / `ask` / `acceptEdits` | Guardian NEVER runs — behavior byte-identical to pre-guardian. |

## Bands

**Auto borderline band.** The deterministic gate (`shouldPromptInAutoMode`)
already classifies a proposed shell/network/MCP-mutation action into
allow / borderline / deny-or-ask. Only the borderline result — a `prompt` in
`auto` mode — consults the guardian. Low-risk commands never reach the band, so
they add no judge latency. File edits inside the workspace are auto-allowed in
`auto` and never reach the band (`SessionFilesystemScope` already owns them).

**Allow-all high-risk band.** In `allow-all` the deterministic gate auto-allows
everything, so there is no `prompt` band. The deny-net reuses the EXISTING risk
classifier (`shouldPromptInAutoMode`) as its high-risk band — the same risky
tier `auto` mode would ask about (dangerous / destructive / network Bash,
MCP/API mutations). That classifier does not split the four high-risk categories
(secret exfiltration, credential probing, destructive operations,
protected-branch git), so its risky tier IS the band and the judge's policy
prompt does the category filtering: a low/medium-risk action inside the band
returns `no_objection` and runs. A non-high-risk action never consults the
judge (zero latency on the fast path).

## Verdict vocabulary and fail-closed semantics

The judge emits `no_objection` / `deny` / `unsure` — NOT Codex's `allow`/`deny`,
because the guardian is a consulted input, not a second authority.

- `no_objection`: no policy reason to object. The mode's rules still decide.
- `deny`: the action trips a taxonomy deny rule (exfiltration, credential
  probing, persistent security weakening, destructive) or is critical without
  adequate authorization. Blocks with a `[category]: reason` diagnostic that
  the model and the user see.
- `unsure`: the judge cannot reach a confident non-objection or denial. This is
  the fail-closed lane — it routes to a human, never to auto-run.

ANY runner failure — timeout (default 15s), spawn error, aborted, malformed
output, or an out-of-vocabulary verdict — resolves to `unsure`. The judge NEVER
fails open to `no_objection`.

## The judge runner

The judge is a READ-ONLY child session through the EXISTING orchestrator: the
built-in `scout` def (read/grep/find/ls only — no shell, no writes, no network,
no MCP, no spawning), depth budget 1, with the guardian policy as its system
prompt. It can inspect local state (e.g. read a script or check git remotes)
before deciding. Strict structured output is validated through the existing
`parseSchemaResult` path plus an explicit verdict-vocabulary guard; bounded
retry (2 attempts); a hard timeout via an `AbortController` wired to the
spawner's signal; and bounded input caps.

The judge runs host-side as a `guardianJudgePort` injected into
`CoreBackendConfig` and wired over the host-owned `piChildSessionPort` — the
same child-session start path subagent/review use — so there is no new
host↔subprocess RPC class and no new package edge. The reusable core
(`runGuardianJudgeCore`, shared) is used by both the host port and
pi-agent-server's `runGuardianJudge`.

Default judge model: the Nessy Gateway `fast` alias
(`resolveGatewayFastModelId`), resolved by alias at runtime because the
underlying id rotates; fallback is the session model. A product setting can
override the model with any model from the active connection catalog.

## Untrusted evidence

The ONLY authorization evidence is the user's own current-turn message
(`trustedIntent`). Tool outputs, file contents, and MCP params are fenced in
`<untrusted>` markers; the policy instructs the judge that marker content is
never authorization and never instructions. Literal `<untrusted>` fence markers
inside attacker-controlled body text are neutralized so a poisoned tool output
cannot close the fence early and forge trusted structure. The model-authored
`reason`/`category` are sanitized (single-line, bounded, taxonomy-checked) at
the core boundary before they reach any diagnostic, audit receipt, or UI.

## Bounded cost and looping

- Per-session verdict cache keyed by (normalized action hash, cwd), invalidated
  on mode switch, size-bounded (200) with LRU-on-write. A cache hit skips the
  judge.
- Per-turn circuit breaker (Codex pattern): 3 consecutive denies OR 10 within
  the last 50 consulted actions stops consulting for the rest of the turn and
  falls the band back to asking. Reset at the turn boundary.
- Per-turn deny loop-guard: a model re-issuing the same judge-denied action
  escalates the diagnostic and feeds the circuit breaker.
- Post-denial override: once the user explicitly approves a judge-denied action,
  that exact (action, cwd) is never re-consulted for the session — the human
  wins.

## Provenance

Every consulted verdict lands in the existing permission audit surface: allow
and deny flow through `permissionService.authorize` (receipt + the existing
PermissionRequest/PermissionDenied automation events). A guardian-approved allow
threads a `guardian-approved[ category]: reason` marker through the decision's
existing `additionalContext` string (no wire-contract change), so the audit
receipt is distinguishable from a plain rule-allow. A deny carries the visible
`[category]: reason` diagnostic through the standard block-reason path, which
the renderer surfaces exactly like any permission denial.

## Product setting

Guardian on/off and the judge model are a product setting (not a build flag),
under Settings → AI → Guardian, plumbed through the settings RPC
(`guardian:getEnabled` / `setEnabled` / `getModel` / `setModel`) into config
storage (`guardianEnabled`, `guardianJudgeModelId`). Default: ON. The setting is
read LIVE per consult, so a toggle applies without a restart. When off, both
bands are skipped and all paths are byte-identical to pre-guardian.

## Reference

The policy prompt adapts the openai/codex guardian `policy.md` +
`policy_template.md` (Apache-2.0) verbatim where it fits; the verdict
vocabulary, JSON schema, template slots, and read-only runner are
Nessy-specific. Three Pi-ecosystem LLM judges (`pi-safeguard`,
`pi-approval-guardian`, `@ikuradon/pi-guardian`) are pattern references only:
no source was vendored and no npm dependency was added for any of them. Their
provenance was recorded in `docs/architecture/pi-extension-adoption-scorecard.md`,
deleted in `97f7e7af`; recover it with
`git show 97f7e7af^:docs/architecture/pi-extension-adoption-scorecard.md`.
