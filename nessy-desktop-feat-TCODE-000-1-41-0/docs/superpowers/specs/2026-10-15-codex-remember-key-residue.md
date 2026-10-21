# Codex residues of the remember key and the argv inspectors (UB1.7, measured 2026-10-15)

Row: UB1.7 of `docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md`
(`[codex]` `[measure]`; needs UB1.2, UB1.4 — both landed in 1.42.0 as UA12.70 and
UA12.72). Done means: each question has a measured verdict with the codex version
from both self-reports, recorded as UNIFORM, HONEST residue, or a new row.

## Versions

Honest limits first: this environment has **no `codex` binary on PATH** and no
network beyond the mirrors the plan names, so the binary's own `--version` and
`package.json` self-reports could not be read here. The versions this file names
are the tree's own records: the shipped binary our citations carry is
**`openai/codex@rust-v0.156.1`** (F1.870's and F1.928's docblocks in
`packages/shared/src/agent/codex-agent.ts`, each citing codex-rs files), and the
vendored protocol client is **`packages/codex-protocol` 1.0.2**. A binary
measurement on a newer binary can reopen either verdict; the instrument for that
is a live drive (`codex exec` with `approvalPolicy`, controls `ls` and
`rm -rf ./x`), which is recorded below as NOT RUN.

## Q1 — after Approve-for-session on `node -e "…"`, does codex's native cache auto-approve `node evil.js`?

**Verdict: NOT MEASURED on the binary; the source-anchored reading in our tree
says no — the cache is keyed per command, so a different command re-asks. Residue
stays as recorded; no new row.**

- NOT RUN: the live drive (no binary; the instrument would be `codex exec` with
  the approval policy on, approve `node -e "console.log(1)"` for the session,
  then send `node evil.js`, with `ls` (auto) and `rm -rf ./x` (asks) as controls).
- The tree's source-anchored claim (strong per the AGENTS.md asymmetry — codex
  source outranks its pages): `codex-rs/core/src/tools/sandboxing.rs`
  `with_cached_approval` — "If all keys are already approved for session, we skip
  prompting" (cited in `codex-agent.ts`'s F1.870 docblock at the shipped
  `rust-v0.156.1`). The keys are the commands approved, not the interpreter or a
  prefix: under that reading `node evil.js` is a new key and asks again.
- Our own projection agrees in shape (measured, see Q2's probe): the durable form
  of an approved exact line is a `prefix_rule` over the exact argv, and
  `node evil.js` is a different argv. Should a live drive measure otherwise
  (a cached `node -e` approving `node evil.js`), that is a measured gap → a new
  row born against the projection and the floor; nothing in this file closes it.

## Q2 — does our host gate auto-accept a codex exec approval for each UB1.4 spelling, or does codex's own `is_known_safe_command` plus its sandbox refuse first?

**Verdict: MEASURED (offline, on our projection and gate functions) — our host
gate does NOT auto-accept the UB1.4 spellings. They never reach codex's execpolicy
as allow rules at all, and the host's approval answerer auto-accepts only what an
exact durable rule names. UNIFORM, HONEST residue: the read-only allowlist and the
argv inspectors are host functions on Pi and Claude; codex keeps its native
approvals and its sandbox.**

Measured this session (`work/l-p1/ub1.7-probe.ts`, run under `bun`, output
quoted):

- The remember key UA12.70 persists for an exact line is the exact-argv key:
  `bashSessionWhitelistKey('node -e "console.log(1)"', 'node')` →
  `exact:["node","-e","console.log(1)"]`, and for `node evil.js` a DIFFERENT key
  `exact:["node","evil.js"]` — key equality, never a prefix.
- The workspace store's exact-argv allow projects into codex's rules text as
  `prefix_rule(pattern=["node","-e","console.log(1)"], decision="allow")`
  (`buildCodexExecpolicyRules`), and the probe answers
  `covers node evil.js? false`: codex's own execpolicy holds the approved argv
  exactly, so the interpreter's other commands still ask.
- The UB1.4 spellings (`sed -n 's/a/b/w out' f`, `sed -n -Ei …`, `sort -uo out
  in`, `gh api -XPOST …`, the method-override header) are carried by the SHIPPED
  read-only allowlist, which is regex-shaped
  (`collectExecpolicyAllowPrefixes` skips every matcher with a `pattern`) — so a
  store without user-written DSL allow rules projects `[]` (measured). Codex's
  execpolicy therefore has NO allow for them: an exec approval for such a line
  comes to the host, `consultPermissionRules` finds no rule and answers `null`,
  and the human default stands. On the codex side the sandbox mode
  (`read-only`/`workspaceWrite`, the `is_known_safe_command` reading cited in the
  projection's docblocks) may refuse first — that half is the source-level
  hypothesis the AGENTS.md asymmetry marks it as, not a binary measurement.
- Controls named by the row, at the level measurable here: `ls` is auto through
  codex's own allowlist (its binary behavior — not measurable offline, source
  reading only); `rm -rf ./x` matches no projected rule and no exact key, so it
  asks (both our projection and, per the same source reading, codex's own floor).

## Disposition

- UNIFORM residue kept: codex answers shell approvals through its native
  execpolicy + session cache + sandbox; the host projects only exact, literal
  user rules into it (F1.1057) and answers what it is asked with the human as the
  default. The UB1.2/UB1.4 host hardening does not widen what runs card-free on
  codex — measured, not assumed.
- No code change, no new row: no measured gap. The live-drive instrument (the
  two questions with the `ls` / `rm -rf ./x` controls, on a real binary) is owed
  to a packaged sitting and re-runs whenever a codex binary is in the
  environment; it is recorded in the row's sitting expectations, not here.
