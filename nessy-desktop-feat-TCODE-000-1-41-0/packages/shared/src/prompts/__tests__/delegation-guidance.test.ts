/**
 * C3.112 (QH7) — the delegation instruction reaches every prompt the runtime
 * does not build for us.
 *
 * `agent-sdk/subagents.md#run-opus-5-with-subagents` splits the behaviour by
 * system prompt: the `claude_code` preset adds its own line on Opus 5, while
 * *"A custom prompt, or no `systemPrompt`"* carries none and the page's advice
 * is to *"Add the prompting guide's delegation instruction to your own
 * prompt."* Three arms take a plain string in this fork — Pi's composed prompt,
 * Pi's `mini` preset and claude's `mini` branch — and all three are this one
 * function pair, so the assertions below are the whole surface.
 *
 * The claude REGULAR arm is deliberately not asserted here: its text is the
 * runtime's, added by the preset, and our append is the same
 * {@link getSystemPrompt} output this file already drives. Asserting it would
 * mean importing `claude-agent.ts`'s module graph to read a constant this file
 * owns.
 */
import { describe, it, expect } from 'bun:test'
import {
  DELEGATION_GUIDANCE_PARAGRAPH,
  getMiniAgentSystemPrompt,
  getSystemPrompt,
} from '../system.ts'

describe('C3.112 — the delegation guidance the page prescribes for a custom prompt', () => {
  it('is present in the composed prompt Pi and the claude append both take', () => {
    const prompt = getSystemPrompt(undefined, undefined, '/workspace', '/workspace')
    expect(prompt).toContain(DELEGATION_GUIDANCE_PARAGRAPH)
    // ONCE. The paragraph sits in a template literal beside a section that
    // already discusses subagents; two copies would be a merge accident that
    // reads as normal text.
    expect(prompt.split(DELEGATION_GUIDANCE_PARAGRAPH).length - 1).toBe(1)
  })

  it('is present in the mini prompt, on both backends, through the one function that builds it', () => {
    // `BaseAgent.getMiniSystemPrompt` (claude's `miniSystemPrompt`) and
    // `getSystemPrompt(..., 'mini')` (Pi's preset switch) are the same text.
    const direct = getMiniAgentSystemPrompt('/workspace')
    const viaPreset = getSystemPrompt(undefined, undefined, '/workspace', '/workspace', 'mini')
    expect(direct).toContain(DELEGATION_GUIDANCE_PARAGRAPH)
    expect(viaPreset).toBe(direct)
  })

  it('says the four things the guide names, and is not the subagent tool description', () => {
    // The four rules of the Opus-5 prompting guide's own example instruction,
    // adapted: independent and sizeable work only, not work you could finish
    // yourself, not self-verification, one agent rather than several.
    expect(DELEGATION_GUIDANCE_PARAGRAPH).toContain('genuinely independent')
    expect(DELEGATION_GUIDANCE_PARAGRAPH).toContain('handful of')
    expect(DELEGATION_GUIDANCE_PARAGRAPH).toContain('double-check your own work')
    expect(DELEGATION_GUIDANCE_PARAGRAPH).toContain('one rather than several')
    // The row's own control, and it is what made the gap visible: Pi's spawner
    // description ('Delegate focused work', `pi-agent-server/src/orchestrator/
    // subagent-tool.ts`) resolves in this tree while no delegation GUIDANCE
    // did. A tool description is not a prompt instruction, so finding that
    // string here would mean the assertion above was reading the wrong text.
    const prompt = getSystemPrompt(undefined, undefined, '/workspace', '/workspace')
    expect(prompt).not.toContain('Delegate focused work')
  })
})
