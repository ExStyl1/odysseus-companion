/**
 * Q11 — every `BackendConfig` field must REACH `ClaudeAgent`, and this file is
 * the thing that notices when one stops.
 *
 * `ClaudeAgent`'s constructor used to rebuild a fresh `BackendConfig` from a
 * hand-written list of ~25 names. `BackendConfig` has 67 fields. The other 42
 * were deleted for every Claude session, silently — no type error, because the
 * far-side reads are all optional — however correctly `SessionManager` had
 * filled them. Q8-D3 found ONE of them (`piRuntimeAgentDefinitions`, which is
 * why the SDK kept answering `Agent type '<ours>' not found`); the audit behind
 * this file found that a trusted project was being treated as untrusted, that
 * one Claude session's `destroy()` tore down the SHARED workspace MCP pool, that
 * a disabled 1M-context setting never applied, and that oversized images were
 * refused instead of resized.
 *
 * So the assertion here is deliberately NOT a list of field names — a list is
 * the same hand-maintained artefact that caused the defect, one layer up. The
 * field set is re-derived from `backend/types.ts`'s own source at test time, so
 * a field added to `BackendConfig` tomorrow is covered the moment it is
 * declared, by a developer who never reads this file.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ClaudeAgent } from '../claude-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

const TYPES_PATH = fileURLToPath(new URL('../backend/types.ts', import.meta.url));

/**
 * The declared members of `BackendConfig`, read from the interface's own
 * source. Both halves are needed: `BackendConfig extends CoreBackendConfig`,
 * and the 60/8 split between them is an implementation detail no caller sees.
 */
function declaredBackendConfigFields(): string[] {
  const source = ts.createSourceFile(
    TYPES_PATH,
    readFileSync(TYPES_PATH, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found = new Set<string>();
  source.forEachChild(node => {
    if (!ts.isInterfaceDeclaration(node)) return;
    if (node.name.text !== 'CoreBackendConfig' && node.name.text !== 'BackendConfig') return;
    for (const member of node.members) {
      if (ts.isPropertySignature(member)) found.add(member.name.getText(source));
    }
  });
  return [...found];
}

/**
 * The two values `ClaudeAgent` OWNS and therefore may legitimately override.
 * Both are asserted positively below — an override that stops happening is a
 * defect too, so neither is merely skipped.
 */
const OVERRIDDEN = new Set(['provider', 'model']);

/**
 * Fields the constructor genuinely dereferences, which therefore need a real
 * shape rather than a probe token. Everything else gets a unique object whose
 * IDENTITY is the assertion — no coincidental value can satisfy it.
 */
function probeConfig(suffix: string): {
  probe: Record<string, unknown>;
  fields: string[];
  sessionModel: string;
} {
  const fields = declaredBackendConfigFields();
  const probe: Record<string, unknown> = {};
  for (const field of fields) probe[field] = { q11Probe: field };
  const sessionModel = `q11-session-model-${suffix}`;
  probe.workspace = {
    id: `ws-q11-${suffix}`,
    name: 'Q11 Workspace',
    rootPath: `/tmp/ws-q11-${suffix}`,
    workspaceRootPath: `/tmp/ws-q11-${suffix}`,
    sessionRootPath: `/tmp/ws-q11-${suffix}/sessions`,
  };
  probe.session = {
    id: `session-q11-${suffix}`,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    workingDirectory: `/tmp/ws-q11-${suffix}`,
    // Pins the documented resolution order: the SESSION model wins over
    // `config.model`, and the context window is derived from the same answer.
    model: sessionModel,
  };
  // `mcpPool` joined the fields the constructor genuinely dereferences when the
  // Claude runtime started registering this session's MCP elicitation surface
  // (Q13-D1). It keeps its probe token — identity is still the assertion — and
  // gains only the two methods that path can call.
  probe.mcpPool = {
    q11Probe: 'mcpPool',
    registerElicitationHandler: () => () => {},
    setElicitationHandler: () => {},
  };
  probe.model = `q11-config-model-${suffix}`;
  probe.thinkingLevel = 'medium';
  // Deliberately WRONG on the way in: this class is the anthropic backend and
  // must fix its own provider rather than take the caller's word for it.
  probe.provider = 'pi';
  return { probe, fields, sessionModel };
}

function agentConfigOf(agent: ClaudeAgent): Record<string, unknown> {
  return (agent as unknown as { config: Record<string, unknown> }).config;
}

describe('ClaudeAgent config projection', () => {
  it('re-derives a non-trivial field set from BackendConfig itself', () => {
    // Without this, a parser regression that found NOTHING would make every
    // assertion below vacuously green — the exact failure mode a structural
    // test has to rule out for itself.
    const fields = declaredBackendConfigFields();
    expect(fields.length).toBeGreaterThanOrEqual(60);
    expect(fields).toContain('workspace');
    expect(fields).toContain('provider');
    expect(fields).toContain('piRuntimeAgentDefinitions');
  });

  it('hands BaseAgent every declared BackendConfig field', () => {
    const { probe, fields } = probeConfig('all-fields');
    const config = agentConfigOf(new ClaudeAgent(probe as unknown as BackendConfig));

    const dropped = fields.filter(field => !OVERRIDDEN.has(field) && !(field in config));
    expect(dropped).toEqual([]);

    const altered = fields.filter(
      field => !OVERRIDDEN.has(field) && config[field] !== probe[field],
    );
    expect(altered).toEqual([]);
  });

  it('overrides exactly provider and model, and says what they resolve to', () => {
    const { probe, sessionModel } = probeConfig('overrides');
    const config = agentConfigOf(new ClaudeAgent(probe as unknown as BackendConfig));

    // The caller passed 'pi'. This class is the anthropic backend.
    expect(config.provider).toBe('anthropic');
    // Session model beats `config.model`; `CLAUDE_CONTEXT_WINDOW` is derived
    // from this same resolution, so the two can never disagree.
    expect(config.model).toBe(sessionModel);
  });

  /**
   * The named pins. Redundant with the structural sweep above BY DESIGN: these
   * five (six until F1.1241 removed `enable1MContext`) are the fields whose absence was measured to change behaviour, so they
   * keep an assertion that names the consequence even if the source parse ever
   * degrades.
   */
  it('keeps the fields whose absence was measured to change behaviour', () => {
    const { probe } = probeConfig('measured');
    const config = agentConfigOf(new ClaudeAgent(probe as unknown as BackendConfig));

    // A trusted project read as untrusted: no project memory/instruction block
    // in the system prompt, no project output styles. Fail-closed, so never a
    // widening — but a silent divergence from Pi on the same project.
    expect(config.projectTrusted).toBe(probe.projectTrusted);
    // `${CLAUDE_PROJECT_DIR}` for skills and the MCP `projectDirectory` fall
    // back to the working directory without it.
    expect(config.filesystemScope).toBe(probe.filesystemScope);
    // The turn's tool universe for the `EndConversation` carve-out in
    // `applySkillInvocationRemoval`.
    expect(config.piAllowedTools).toBe(probe.piAllowedTools);
    // Without it, `BaseAgent.destroy()` reads the LEASED shared workspace MCP
    // pool as a private one and calls `disconnectAll()` — dropping servers that
    // browse and other live sessions are still leasing.
    expect(config.mcpLeaserId).toBe(probe.mcpLeaserId);
    // Without it an oversized image Read is BLOCKED ("Image too large") instead
    // of being resized and retried.
    expect(config.onImageResize).toBe(probe.onImageResize);
  });
});
