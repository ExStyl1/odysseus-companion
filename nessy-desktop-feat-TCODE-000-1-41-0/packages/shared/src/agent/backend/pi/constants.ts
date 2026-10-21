/**
 * Pi Backend Constants
 *
 * Shared constants used by the Pi agent and its event adapter.
 * Extracted here to avoid circular imports between pi-agent.ts and event-adapter.ts.
 */

import type { ThinkingLevel as PiThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel } from "../../thinking-levels.ts";

/**
 * Map Nessy's {@link ThinkingLevel} to Pi's `ThinkingLevel`.
 *
 * IDENTITY, and it used to saturate. This said "Pi's ceiling is `xhigh`; Nessy's
 * `max` saturates there", and at the installed SDK that is false in both halves.
 * Measured against `@earendil-works/pi-agent-core` 0.84.0, and every bullet
 * re-measured unchanged on 0.84.2 (S0-3, 2026-09-03) and again on 0.84.3
 * (W11-pi, 2026-09-11): same seven `ThinkingLevel`
 * arms, `clampThinkingLevel` still on both session seams (`agent-session.js`,
 * `core/sdk.js`), and the provider tables still give `"max": "max"` to seven
 * anthropic ids and three openai ones — re-derived at 0.84.3 by reading each
 * model's `thinkingLevelMap.max`, which names the same seven `claude-*` ids
 * below and the same three `gpt-5.6-*`:
 *
 *  - `dist/types.d.ts` — `ThinkingLevel = "off" | "minimal" | "low" | "medium" |
 *    "high" | "xhigh" | "max"`, and the package README repeats the same seven in
 *    its `initialState` example. `max` is a first-class Pi level, not a ceiling.
 *  - `@earendil-works/pi-ai` `dist/models.js` has Pi's OWN per-model narrowing —
 *    `getSupportedThinkingLevels(model)` reads each model's `thinkingLevelMap`
 *    and `clampThinkingLevel(model, level)` falls back to "the highest supported
 *    level at or below the one you set", which is the same rule
 *    `model-config.md#adjust-effort-level` states for Claude.
 *  - That clamp is ON the path, twice: `pi-coding-agent`'s
 *    `core/agent-session.js` `setThinkingLevel` clamps before storing, and
 *    `core/sdk.js` clamps at session creation. Both are the seams
 *    `pi-agent-server` drives (`set_thinking_level`, and `sessionOptions.thinkingLevel`).
 *  - The provider data says which models it costs: `pi-ai`'s
 *    `providers/data/anthropic.json` gives `claude-opus-5`, `claude-sonnet-5`,
 *    `claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-4-6`, `claude-sonnet-4-6`
 *    and `claude-fable-5` a `thinkingLevelMap` containing `"max": "max"`, and
 *    `openai.json` does the same for the `gpt-5.6-*` family.
 *
 * So the saturation was a HOST cap that pre-empted Pi's own per-model table: on
 * every model that really supports `max`, a user who chose Max silently got
 * XHigh, and on the models that do not, Pi's clamp lands on exactly the value
 * the saturation was hard-coding anyway. Removing it gives the native mechanism
 * the decision back — native-first, and one less thing that differs from Claude
 * and codex at a runtime switch.
 */
export const THINKING_TO_PI: Record<ThinkingLevel, PiThinkingLevel> = {
	off: "off",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};
