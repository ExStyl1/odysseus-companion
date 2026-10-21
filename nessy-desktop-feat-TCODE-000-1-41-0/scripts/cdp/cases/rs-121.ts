/**
 * RS-121 (F1.749) — the background subagent's MCP roster, read at the runtime
 * record instead of asked of the model.
 *
 * ## The row
 *
 * F1.749 (origin: the 1.41.0 release sitting, lane SIT-h, 2026-09-25) was born from
 * C23: background subagents on claude-gateway twice SELF-reported having no
 * `mcp__session__Monitor` ("only Read, Bash, Edit, Write"), contradicting F1.401's
 * premise that a claude background subagent "inherits the mcp__session__Monitor and
 * archive_session tools". SIT-h itself flagged the weakness — a self-report is not a
 * roster read — and the row asks for exactly that: a probe of the subagent's init
 * tools before C23/C24 are re-driven.
 *
 * ## The instrument
 *
 * The packaged build already writes the runtime record: the Claude SDK's own
 * per-agent JSONLs under `<workspaceRoot>/claude-config/projects/<cwd>/<session>/`,
 * the subagent's under a `subagents/agent-*.jsonl` beside its parent's. The roster
 * comparison needs no model cooperation: the PARENT's JSONL carries a tools-roster
 * attachment (per-tool `{name, description, …, server}` entries), the CHILD's either
 * carries one or carries none plus its own enumeration of what it was given. Diff
 * the two files; never diff two model answers.
 *
 * ## The measured answer (RC4, 2026-10-11, lane L5F2, port 9342)
 *
 * Driven on the packaged 1.42.0 RC4 (`b72bb163d`), claude-gateway bound and the
 * bound connection READ BACK (`work/sitting7/L5F2/f1749-claude-reading.json`; the
 * first probe attempt never switched its card and measured pi — see the correction
 * inside `rs-120.ts`, the same rig error):
 *
 * - **PARENT: 57** `mcp__session__*` tool definitions in its request roster,
 *   `mcp__session__Monitor` and `mcp__session__archive_session` among them.
 * - **CHILD (the background subagent, `subagents/agent-*.jsonl`): 0** — no roster
 *   attachment, no `mcp__` tool name anywhere in its runtime record; the model's
 *   own tool context enumerated "only Read, Bash, Edit, Write"; it issued NO
 *   Monitor tool_use and could not (a model cannot emit a tool_use for a name
 *   outside its tools array — its "I attempted to call" was phrasing, which is
 *   exactly why the roster read, not the answer, is the evidence).
 * - **The mechanism, cited**: the subagent came from the host's OWN agent
 *   definitions — `FULL_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find',
 *   'ls']` (`packages/shared/src/agents/definitions.ts`), no `mcp__session__*`
 *   entry, and `general-purpose` is not offered on this build (the parent's
 *   transcript names planner / reviewer / scout / worker only). The premise's
 *   inheritance therefore does not happen for ANY claude subagent this product
 *   can spawn.
 * - Consequence for the premise's consumer: F1.401's landed turn-bound-card logic
 *   (`9667bfbd4`) still holds its host-side behaviour, but on RC4 no subagent can
 *   raise a Monitor/archive card — the out-of-turn raiser that remains is the
 *   main agent's own post-notification turn (SIT-h's other observation).
 * - The row's SECOND claim (the SDK starting a main-agent turn on its own after a
 *   task notification, raising a card at `isProcessing=false`) was NOT reproduced
 *   in this sitting's drives — the C24 shape was reached through the child's own
 *   Bash card instead. It stays open, model-dependent.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-121'
const TITLE =
  'what MCP tools a claude background subagent actually receives: the parent-vs-child runtime-record roster diff'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'F1.749',
  runtimes: ['claude'],
  credentials:
    'owner: the Claude Code (Nessy Gateway) one-click card. No key, token or credential file is read; '
    + 'the instrument is the session\'s own claude-config JSONLs on disk.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. Launch the PACKAGED build (scripts/cdp/README.md\'s env -u launcher). FreshSession, bind the claude-gateway card with switchRuntime, and RECORD THE BOUND CONNECTION back (getSessions → llmConnection) — a session that never switched measures the profile\'s default card (measured: pi) and the whole reading is about the wrong runtime.',
    '2. Snapshot the `<workspaceRoot>/claude-config/projects/**` *.jsonl tree (paths + mtimes) BEFORE the probe, so the child\'s file is identified by the diff and not by guessing which uuid is which.',
    '3. THE PROBE: prompt the main agent to start exactly one background subagent (its Task tool, run_in_background) whose instruction is to call `mcp__session__Monitor` (read-only action) and then report (1) the exact tool result or error text verbatim and (2) every tool name it can see starting with mcp__. The ANSWER is context, never evidence.',
    '4. THE ROSTER READ, runtime-record only: in the parent\'s JSONL count the roster-style tool definitions (`{"name":"mcp__…", …, "server":"session"}` entries of the tools attachment); in the child\'s `subagents/agent-*.jsonl` count the same. Also record: any real `tool_use` blocks in the child (a model CANNOT emit one for a name outside its tools array) and the child\'s own enumeration of its functions.',
    '5. THE MECHANISM: name where the subagent\'s tool list comes from — the host\'s agent definitions passed through the SDK `agents` option (`packages/shared/src/agents/definitions.ts` toolsets; explicitly-passed definitions scope the subagent\'s servers per the SDK\'s own strictMcpConfig wording) — and which agent types this build offers, so the verdict\'s scope is "every claude subagent this product can spawn", not one type.',
    '6. Verdict: the premise "the subagent inherits mcp__session__Monitor/archive_session" holds only if the CHILD\'S roster carries them at parity with the parent\'s; a child roster without them REFUTES it — file the consumer (F1.401\'s turn-bound-card logic and its row) a note that the subagent-raised-card path is unreachable on this build.',
  ],
  expected:
    'A parent-vs-child roster diff taken from the two JSONLs the runtime itself wrote: the parent\'s count, the child\'s count, the child\'s real tool_use blocks (expected zero for a tool it does not have), and the named mechanism that produced the difference.',
  detector:
    'The Claude SDK\'s own claude-config JSONLs: the tools-roster attachment in the parent\'s file, its absence or '
    + 'narrowing in the child\'s `subagents/agent-*.jsonl`, plus the tool_use records as the call-level check. '
    + 'The model\'s prose in either transcript is context only — C23 measured it twice and it is not a roster.',
  positiveControl:
    'Three: (1) the bound-connection read-back — a session on the default card measures pi and the whole reading '
    + 'is about the wrong runtime; (2) the PARENT\'S roster must show the session tools (dozens of mcp__session__* '
    + 'definitions) — a parent read that shows none means the roster attachment was not found and the diff proves '
    + 'nothing; (3) the child\'s own enumerated function list must agree with its roster (no mcp__ names) — two '
    + 'independent records of the same child, and they must not disagree.',
  doneMeans:
    'F1.749\'s premise question is answered at the runtime-record level: whether claude background subagents '
    + 'inherit the session MCP tools, with the mechanism named and the consumer premise (F1.401\'s '
    + 'subagent-raised-card path) annotated.',
  doNotConflate:
    'The child SAYING "unknown tool" is not the runtime ANSWERING unknown-tool: a model cannot emit a tool_use '
    + 'for a name outside its tools array, so a prose "attempt" with no tool_use block is phrasing — the roster '
    + 'attachment is the only runtime-grade read. And the agent type matters for scope: the premise is refuted '
    + 'for the types this build offers, not for a hypothetical general-purpose agent nothing can spawn.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
