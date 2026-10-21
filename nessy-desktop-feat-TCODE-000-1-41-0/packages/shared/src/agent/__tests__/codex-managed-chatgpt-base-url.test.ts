/**
 * A3.5 — a managed `chatgptBaseUrl` cannot produce a session that is treated as
 * the verified gateway while pointing somewhere else.
 *
 * ## The row's risk, stated as the row states it
 *
 * `rust-v0.150.1` gave `ConfigRequirements` a `chatgptBaseUrl` field (re-read at
 * `rust-v0.154.0`), and this fork attaches a corporate `Nestor-Token` to exactly
 * one URL. A managed key that moves a session's base URL must not silently
 * redirect a session the host believes is on the verified gateway, nor silently
 * attach that token to somewhere else.
 *
 * ## The verdict, already in the tree
 *
 * `CODEX_REQUIREMENT_ENFORCEMENT.chatgptBaseUrl` is `'codex'`, read from
 * `core/src/config/requirements.rs`'s `apply_exact!` list at the STRONG tier.
 * codex spends `chatgpt_base_url` on its own ChatGPT backend, its plugin manager
 * and its `McpConfig`; our sessions run on a DECLARED `model_providers.*` entry
 * with its own `base_url`, which the requirement does not touch.
 *
 * ## What this file adds — the NEGATIVE the verdict was missing
 *
 * A verdict is a sentence about somebody else's code. These four cases are the
 * part that is ours, and each one is a different way the redirect could have
 * happened:
 *
 *  1. **CONTROL.** The gateway predicate answers `true` for the one URL and the
 *     three provider types, so the probe can see. Without it every negative
 *     below is satisfied by a predicate that answers `false` to everything.
 *  2. **The predicate reads its ARGUMENT and nothing else.** A reported
 *     `chatgptBaseUrl` is not an input to it — there is no seam through which it
 *     could become one — and reading the requirements document does not move the
 *     answer for either arm.
 *  3. **The writer never emits the key.** A managed value cannot be laundered
 *     into the session's own `config.toml`: `chatgpt_base_url` appears in no
 *     table `buildCodexConfigToml` writes, while the declared provider's own
 *     `base_url` does — which is the control that proves the search can find a
 *     base URL when there is one.
 *  4. **The administrator's report says who enforces it.** A reported
 *     `chatgptBaseUrl` lands in `codexEnforced`, never in `honoured`: a fleet
 *     reading the report is told codex applies it and this host does not, which
 *     is the true sentence.
 */
import { describe, expect, it } from 'bun:test';
import { buildCodexConfigToml } from '@nessy-agent/codex-responses-adapter/config-writer';
import type { CodexConfigOptions } from '@nessy-agent/codex-responses-adapter/config-writer';
import {
  NESSY_GATEWAY_CHAT_BASE_URL,
  isGatewayBackedConnection,
  isNessyGatewayBaseUrl,
} from '../backend/internal/drivers/upstream-target.ts';
import {
  CODEX_REQUIREMENT_ENFORCEMENT,
  readCodexConfigRequirements,
} from '../codex-config-requirements.ts';

/** Where a managed requirement would send the session if anything read it. */
const ELSEWHERE = 'https://chatgpt-mirror.example.invalid/backend-api';

const BASE: CodexConfigOptions = {
  codexHome: '/tmp/a3-5',
  model: 'tgpt/deepseek-v4-flash-0731',
  adapterPort: 54321,
};

describe('A3.5 · a managed chatgptBaseUrl and the verified gateway', () => {
  it('CONTROL — the gateway predicate answers true for the one URL and the three provider types', () => {
    expect(isNessyGatewayBaseUrl(NESSY_GATEWAY_CHAT_BASE_URL)).toBe(true);
    for (const providerType of ['pi_compat', 'claude-runtime', 'codex-runtime']) {
      expect(isGatewayBackedConnection({ providerType, baseUrl: NESSY_GATEWAY_CHAT_BASE_URL })).toBe(true);
    }
  });

  it('NEGATIVE — reading a managed chatgptBaseUrl moves neither arm of the predicate', () => {
    const reading = readCodexConfigRequirements({ requirements: { chatgptBaseUrl: ELSEWHERE } });
    expect([...reading.codexEnforced]).toEqual(['chatgptBaseUrl']);

    // The URL the requirement names is not the gateway, in any provider type…
    expect(isNessyGatewayBaseUrl(ELSEWHERE)).toBe(false);
    expect(isGatewayBackedConnection({ providerType: 'codex-runtime', baseUrl: ELSEWHERE })).toBe(false);
    // …and the one that IS the gateway still is. The predicate answers from its
    // argument; there is no state a requirements document could have moved.
    expect(isGatewayBackedConnection({ providerType: 'codex-runtime', baseUrl: NESSY_GATEWAY_CHAT_BASE_URL }))
      .toBe(true);
  });

  it('NEGATIVE — the writer emits no chatgpt_base_url, so a managed value cannot be laundered into our config', () => {
    const toml = buildCodexConfigToml({
      ...BASE,
      // The shape a redirect would have to take to reach the child: whatever a
      // caller hands the writer, this key is not one of the things it writes.
      ...({ chatgptBaseUrl: ELSEWHERE } as Partial<CodexConfigOptions>),
    });

    expect(toml).not.toContain('chatgpt_base_url');
    expect(toml).not.toContain(ELSEWHERE);
    // The control that proves the search can find a base URL when there is one:
    // the DECLARED provider's own key is what a codex session of ours runs on.
    expect(toml).toContain('base_url');
  });

  it('NEGATIVE — the field is reported as codex-enforced and never as honoured by this host', () => {
    expect(CODEX_REQUIREMENT_ENFORCEMENT.chatgptBaseUrl).toBe('codex');
    const reading = readCodexConfigRequirements({ requirements: { chatgptBaseUrl: ELSEWHERE } });
    expect([...reading.honoured]).toEqual([]);
    expect([...reading.unrecognised]).toEqual([]);
  });
});
