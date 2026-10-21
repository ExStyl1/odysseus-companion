# 2026-09-20 — SIT-11: the built-in MCP servers, the bundled skills and the plugin path on the packaged 1.40.0 (dmg #4, `d05d95b13`), all three runtimes

The owner's added release gate (2026-09-20 ~10:40): *"нужно понять, работают ли встроенные MCP/скилы/плагины — это ключевые для работы"*. One sitting driver per runtime, sequential, on the artefact SIT-10 had just passed (bundle mtime 08:30:26); ports 9322–9331; `bypassPermissions` for the rig. Each driver re-drove the shipped cases (`MCP-W1`, `MCP-W2`, `RS-82`, `PLUGIN-INSTALL-RUNTIMES`, `AGENT-INSTALL`, `RS-23`) and then the hand arms for surface A (the dp MCP servers, the session MCP server, the bridge MCP server), B (the seven bundled skills) and C (the plugin path). A read-only verifier per runtime tried to refute every PASS from the evidence alone; a completeness critic gave the GO/NO-GO. The full evidence with every detector quoted is `nessy-wf-checkpoints/work/lane-reports/sit-11-<runtime>-evidence.md`; this narrative carries the verdict tables verbatim.

## `pi`

| Arm | Surface | Result |
| --- | --- | --- |
| RS-32 — the one-click `pi` card seeds and its first turn answers | rig precondition | **PASS** |
| A1 — the built-in dp MCP set is listed with its expected names and its documented posture | A | **PASS** |
| A2 — a built-in dp MCP server that is OFF by default stays off, and enabling it in Settings makes its tools appear | A | **PASS** |
| A3 — a REAL model turn calls a REAL built-in dp MCP tool and the result comes back | A | **PASS** |
| A4 — the session MCP server: a session tool call returns a real result | A | **PASS** |
| A5 — the bridge MCP server | A | **NOT_DRIVABLE on `pi`** (Pi does not use it — source quoted) |
| B1 — the session's own skill roster lists the seven bundled skills | B | **PASS** |
| B2 — invoking a bundled skill produces its output, with the skill BODY demonstrably in the model's context | B | **PASS** |
| B3 — a skill invoked on a FRESH chat works (the D1.435 family) | B | **PASS** |
| C1 — installing a plugin through the product's own marketplace path (`RS-82`) | C | **PASS** |
| C2 — the agent-driven install (`plugin_plan_install` → `plugin_install`), driven by hand | C | **PASS** |
| C3 — the plugin's bundled MCP server appears, and the posture it lands in | C | **PASS** (recorded, not re-decided) |
| C4 — the plugin's minted MCP tool is callable by a real model turn | C | **PASS** |
| C5 — uninstall leaves the roster clean | C | **PASS** |
| C6 — a plugin COMMAND appears in the roster and dispatches | C | **NOT_DRIVABLE this pass** (no fixture ships one — manifest quoted) |
| C7 — a plugin-supplied HOOK fires with the card D1.343 prescribes | C | **NOT_DRIVABLE this pass** (no fixture ships one — manifest quoted) |
| RS-23 — the roster recipe | re-drive | **recipe, not a drive** — pi half performed by hand (B1) |
| MCP-W1 / MCP-W2 | re-drive | see §"The two cases that were not re-driven" |
| AGENT-INSTALL (the case, as shipped) | re-drive | **BLOCKED, twice** — a case defect, diagnosed below |

## `claude-gateway`

| Arm | Surface | Result |
| --- | --- | --- |
| rig — the one-click `claude-gateway` card seeds and every session binds to it | precondition | **PASS** |
| A1 — the built-in dp MCP set is listed with its expected names and its documented posture | A | **PASS** |
| A2 — a built-in dp MCP server that is OFF by default stays off, and enabling it in Settings makes its tools appear | A | **PASS** |
| A3 — a REAL claude-gateway model turn calls a REAL built-in dp MCP tool and the result comes back | A | **PASS** |
| A4 — the session MCP server: `automation_list`, `get_session_info` AND `remember` return real results | A | **PASS** |
| A5 — the bridge MCP server | A | **NOT_DRIVABLE on `claude-gateway`** (Claude does not use it — source quoted) |
| B1 — the roster lists the seven bundled skills, on THREE independent readers incl. the runtime's own | B | **PASS** |
| B2 — invoking a bundled skill produces its output, with the skill BODY demonstrably in the model's context | B | **PASS** |
| B3 — a skill invoked on a FRESH chat works (the D1.435 family) | B | **PASS** |
| C1 — installing a plugin through the product's own marketplace path (`RS-82`, re-driven) | C | **PASS** |
| C2 — the agent channel (`plugin_plan_install` → `plugin_install`), via the shipped `AGENT-INSTALL` case | C | **PASS** |
| C3 — the posture a bundled MCP server lands in after an install | C | **PASS** (recorded, not re-decided) |
| C4 — the plugin's minted MCP tool is callable by a real claude turn | C | **PASS** |
| C5 — uninstall leaves the roster clean | C | **PASS** |
| C6 — a plugin COMMAND appears in the roster and dispatches | C | **PASS** (fixture minted by this lane) |
| C7 — a plugin-supplied HOOK fires with the card D1.343 prescribes | C | **PASS** (fixture minted by this lane) |
| `RS-82` | re-drive | **PASS** |
| `MCP-W1` | re-drive | **10 of 11 ok; FAIL on the detail-page reader only** — refuted as a case defect (P-SIT11CG-1) |
| `MCP-W2` (narrowed to claude) | re-drive | **claude arm 9/9 ok**; case ends BLOCKED because pi/codex were excluded |
| `PLUGIN-INSTALL-RUNTIMES` | re-drive | **PASS** — both the claude AND the codex half |
| `AGENT-INSTALL` | re-drive | **PASS** on claude (it BLOCKED twice on `pi` — the control for P-SIT11-1) |
| `RS-23` | re-drive | **recipe — nothing to drive**; its claude roster step performed by hand (B1) |

## `codex`

| Arm | Surface | Result |
| --- | --- | --- |
| rig — the one-click `codex-gateway` card seeds and every session binds to it | precondition | **PASS** |
| A1 — the built-in dp MCP set is listed with its expected names and its documented posture | A | **PASS** |
| A2 — a built-in dp MCP server OFF by default stays off, and enabling it in Settings makes its tools appear | A | **PASS** |
| A3 — a REAL codex model turn calls a REAL built-in dp MCP tool and the result comes back | A | **PASS** |
| A4 — the session MCP server: `automation_list`, `get_session_info` AND `remember` return real results | A | **PASS** |
| A5 — the bundled `bridge-mcp-server` | A | **NOT_DRIVABLE on `codex`** (no codex consumer — source quoted) |
| A5b — codex's OWN host-callback bridge (the mechanism the codex notice names) | A | **PASS** |
| B1 — the roster lists the seven bundled skills, on two independent readers | B | **PASS** |
| B2 — invoking a bundled skill produces its output, with the skill BODY demonstrably in the model's context | B | **PASS** |
| B3 — a skill invoked on a FRESH chat works (the D1.435 family) | B | **PASS** |
| C1 — installing a plugin through the product's own marketplace path (`RS-82`, re-driven) | C | **PASS** |
| C2 — the AGENT channel (`plugin_plan_install` → `plugin_install`) | C | **NOT_DRIVABLE on `codex`** (gated off for an external subprocess — source quoted) |
| C3 — the posture a bundled MCP server lands in after an install | C | **PASS** (recorded, not re-decided) |
| C4 — the plugin's minted MCP tool is callable by a real codex turn | C | **PASS** |
| C5 — uninstall leaves the roster clean | C | **PASS** |
| C6 — a plugin COMMAND appears in the roster and dispatches | C | **PASS** (fixture minted by this lane) |
| C7 — a plugin-supplied HOOK fires with the card D1.343 prescribes | C | **PASS** (fixture minted by this lane; `PreToolUse` is the documented codex null and is the negative control in the same turn) |
| `MCP-W1` | re-drive | **PASS — 11 of 11** |
| `MCP-W2` (narrowed to codex) | re-drive | **FAIL, 3 of 9** — the case's detector, refuted two ways (P-SIT11CX-1) |
| `RS-82` | re-drive | **PASS — 5 of 5** |
| `PLUGIN-INSTALL-RUNTIMES` | re-drive | **PASS** — the claude AND the codex half |
| `AGENT-INSTALL` | re-drive | **BLOCKED on codex** — the tools are not on the codex surface, by design (C2) |
| `RS-23` | re-drive | **recipe — nothing to drive**; its codex roster + dispatch steps performed by hand |

## Reading

- Every A/B/C hand arm that could be driven **PASSED on every runtime** — the 28 dp MCP names listed with their off-by-default posture, one enabled in Settings live-connecting and answering a real turn; the session MCP server (`automation_list`, `get_session_info`, `remember`) answering; the seven bundled skills in the roster with a skill body demonstrably in the model's context, on a warm and on a fresh chat; a plugin installed through the product's path, its minted MCP tool called by a real turn, uninstall clean; a plugin command and a plugin hook (fixtures minted by the lanes) on claude-gateway and codex.
- **NOT_DRIVABLE, each with its reason quoted from source:** the bundled `bridge-mcp-server` has no consumer on any of the three runtimes (a row); the agent-driven install channel is gated off for codex's external subprocess by design; no shipped fixture carries a plugin command or hook on pi (the other two runtimes minted one).
- **Re-driven cases:** `RS-82` PASS ×3; `MCP-W1` PASS (pi, codex 11/11; claude 10/11 with the detail-page reader refuted as a case defect); `PLUGIN-INSTALL-RUNTIMES` PASS on both halves; `AGENT-INSTALL` PASS on claude, BLOCKED on pi by the case's own one-prompt shape (deferred tools load in one turn and are callable from the next — the hand-driven two-turn install PASSED); `MCP-W2` BLOCKED on pi/claude and FAIL 3/9 on codex by the case's detector (it asks the model for the HOST's row name), refuted two ways on the same pool; `RS-23` is a recipe with nothing to drive.
- Nothing measured here is a product defect in a built-in MCP server, a bundled skill or the plugin path; the case-side findings are rows F1.145–F1.155.
