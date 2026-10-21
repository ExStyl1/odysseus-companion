/**
 * Tests for PiEventAdapter
 *
 * Tests the Pi SDK AgentEvent / AgentSessionEvent → Nessy Desktop AgentEvent conversion.
 * Each test provides mock Pi SDK event objects and verifies the AgentEvents produced.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OrchestrationProgress } from '@nessy-agent/core';
import { PiEventAdapter } from '../backend/pi/event-adapter.ts';
import { toolMetadataStore } from '../../interceptor-common.ts';
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts';
import { getHarnessToolDescriptor, getPiToolBinding } from '../pi-harness/harness-tool-descriptor.ts';

// Helper: collect all events from a generator
function collect(gen: Generator<any>): any[] {
  return [...gen];
}

function notebookManifest() {
  const binding = getPiToolBinding('notebook_edit');
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-events',
    sessionKey: { workspaceId: 'workspace-events', sessionId: 'session-events' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [{
      descriptor: getHarnessToolDescriptor(binding.descriptorId),
      binding,
      source: { kind: 'piBuiltin', bindingId: binding.bindingName },
    }],
  };
  return finalizePiExecutionManifest(seed, []);
}

describe('PiEventAdapter', () => {
  let adapter: PiEventAdapter;
  let sessionDir: string;

  beforeEach(() => {
    adapter = new PiEventAdapter();
    sessionDir = mkdtempSync(join(tmpdir(), 'pi-adapter-'));
    adapter.setSessionDir(sessionDir);
    toolMetadataStore.setSessionDir(sessionDir);
    adapter.startTurn();
  });

  afterEach(() => {
    toolMetadataStore._clearForTesting();
    rmSync(sessionDir, { recursive: true, force: true });
  });

  // ============================================================
  // Agent lifecycle
  // ============================================================

  describe('agent lifecycle', () => {
    it('should emit nothing for agent_start', () => {
      const events = collect(adapter.adaptEvent({ type: 'agent_start' } as any));
      expect(events).toHaveLength(0);
    });

    it('should emit complete for agent_end', () => {
      const events = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'complete' });
    });

    it('forwards structured-output result fields from an enriched agent_end (R18)', () => {
      // Success arm: the validated value + subtype ride the complete event.
      const success = collect(adapter.adaptEvent({
        type: 'agent_end',
        structuredOutput: { ok: true },
        structuredOutputSubtype: 'success',
      } as any));
      expect(success).toHaveLength(1);
      expect(success[0]).toMatchObject({
        type: 'complete',
        structuredOutput: { ok: true },
        structuredOutputSubtype: 'success',
      });

      // Exhaustion arm: subtype + errors + the DOCUMENTED terminal reason.
      const exhausted = collect(adapter.adaptEvent({
        type: 'agent_end',
        structuredOutputSubtype: 'error_max_structured_output_retries',
        structuredOutputErrors: ['$ must have required property \'ok\''],
        terminalReason: 'structured_output_retry_exhausted',
      } as any));
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]).toMatchObject({
        type: 'complete',
        structuredOutputSubtype: 'error_max_structured_output_retries',
        structuredOutputErrors: ['$ must have required property \'ok\''],
        terminalReason: 'structured_output_retry_exhausted',
      });

      // Absent on an ordinary agent_end — byte-identical today's shape.
      const plain = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      expect(plain).toHaveLength(1);
      expect('structuredOutput' in plain[0]).toBe(false);
      expect('structuredOutputSubtype' in plain[0]).toBe(false);
      expect('structuredOutputErrors' in plain[0]).toBe(false);
    });

    it('should forward injected context usage updates', () => {
      const events = collect(adapter.adaptEvent({
        type: 'context_usage_update',
        usage: {
          inputTokens: 42_000,
          contextWindow: 200_000,
          contextWindowSource: 'runtime',
          source: 'sdk_usage',
        },
      } as any));

      expect(events).toEqual([{
        type: 'usage_update',
        usage: {
          inputTokens: 42_000,
          contextWindow: 200_000,
          contextUsage: {
            inputTokens: 42_000,
            contextWindow: 200_000,
            contextWindowSource: 'runtime',
            source: 'sdk_usage',
          },
        },
      }]);
    });
  });

  // ============================================================
  // Turn lifecycle
  // ============================================================

  describe('turn lifecycle', () => {
    it('should set currentTurnId on turn_start', () => {
      // turn_start is handled internally — emits no events
      const events = collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      expect(events).toHaveLength(0);
    });

    it('should emit nothing on turn_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({ type: 'turn_end' } as any));
      expect(events).toHaveLength(0);
    });

    it('should generate sequential turn IDs across turns', () => {
      // First turn (turnIndex=1 from beforeEach startTurn)
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Hello' },
      } as any));
      expect(events1[0].turnId).toMatch(/^pi-turn-1/);

      // End first turn, start second
      collect(adapter.adaptEvent({ type: 'turn_end' } as any));
      adapter.startTurn();
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'World' },
      } as any));
      expect(events2[0].turnId).toMatch(/^pi-turn-2/);
    });
  });

  // ============================================================
  // UB2.5 (R14-24) — reasoning consumed the whole output budget
  // ============================================================

  describe('reasoning ate the output budget', () => {
    it('POSITIVE — output tokens with zero text on a FINAL message emits the warning info once', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: '', usage: { input: 1000, output: 4199, cacheRead: 0 } },
      } as any));

      const infos = events.filter(e => e.type === 'info');
      expect(infos).toHaveLength(1);
      expect(infos[0].level).toBe('warning');
      expect(infos[0].message).toContain('output budget on reasoning');
      expect(infos[0].message).toContain('4199');
    });

    it('CONTROL — an INTERMEDIATE message (stopReason toolUse) with no text emits nothing', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse', content: '', usage: { input: 100, output: 50, cacheRead: 0 } },
      } as any));

      expect(events.filter(e => e.type === 'info')).toHaveLength(0);
    });

    it('CONTROL — a turn that already emitted text emits nothing on a textless final message', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      // The turn said something first…
      collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'the answer', usage: { input: 10, output: 5, cacheRead: 0 } },
      } as any));
      // …then a later textless final message (a folded tool-use round) is silent.
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: '', usage: { input: 10, output: 900, cacheRead: 0 } },
      } as any));

      expect(events.filter(e => e.type === 'info')).toHaveLength(0);
    });

    it('CONTROL — no usage on the textless final message emits nothing', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: '' },
      } as any));
      expect(events.filter(e => e.type === 'info')).toHaveLength(0);
    });
  });

  // ============================================================
  // Message events — text streaming
  // ============================================================

  describe('message events', () => {
    it('should emit nothing for message_start', () => {
      const events = collect(adapter.adaptEvent({ type: 'message_start' } as any));
      expect(events).toHaveLength(0);
    });

    it('should emit text_delta for message_update with text_delta', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_delta',
        text: 'Hello',
      });
      expect(events[0].turnId).toMatch(/^pi-turn-1__m0$/);
    });

    it('should skip message_update without text_delta type', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'usage_delta', delta: null },
      } as any));
      expect(events).toHaveLength(0);
    });

    it('should skip message_update with empty delta', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: '' },
      } as any));
      expect(events).toHaveLength(0);
    });

    it('should reuse same sub-turnId for consecutive deltas', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events1 = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      } as any));
      const events2 = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: ' World' },
      } as any));

      expect(events1[0].turnId).toBe(events2[0].turnId);
    });

    it('should emit thinking deltas as an intermediate text block', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
      } as any));

      const deltaEvents = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'plan' },
      } as any));
      const completeEvents = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'plan' },
      } as any));

      expect(deltaEvents).toHaveLength(1);
      expect(deltaEvents[0]).toMatchObject({
        type: 'text_delta',
        text: 'plan',
      });
      expect(deltaEvents[0].turnId).toMatch(/^pi-turn-1__thinking0$/);
      expect(completeEvents).toEqual([{
        type: 'text_complete',
        text: 'plan',
        isIntermediate: true,
        // P4.4 · the reasoning label. This is an exact-shape assertion, so the
        // new field belongs here rather than being matched loosely — that is
        // what makes it fail if the label is ever dropped from this arm.
        isThinking: true,
        turnId: deltaEvents[0].turnId,
      }]);
    });

    it('should flush unterminated thinking before the final answer', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'plan' },
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'answer' },
      } as any));

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'plan',
        isIntermediate: true,
      });
      expect(events[1]).toMatchObject({
        type: 'text_complete',
        text: 'answer',
        isIntermediate: false,
      });
      expect(events[1].turnId).not.toBe(events[0].turnId);
    });

    it('should emit text_complete for final assistant message_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Hello there' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Hello there',
        isIntermediate: false,
      });
    });

    it('should attach sdkMessageId from message_end onto the text_complete', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        sdkMessageId: 'msg_pi_abc123',
        message: { role: 'assistant', stopReason: 'stop', content: 'Anchored output', id: 'msg_pi_abc123' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Anchored output',
        sdkMessageId: 'msg_pi_abc123',
      });
      // sdkTurnAnchor is delivered separately by a follow-up pi_turn_anchor event.
      expect((events[0] as { sdkTurnAnchor?: string }).sdkTurnAnchor).toBeUndefined();
    });

    it('should forward pi_turn_anchor events as Nessy Desktop AgentEvents', () => {
      const events = collect(adapter.adaptEvent({
        type: 'pi_turn_anchor',
        sdkMessageId: 'msg_pi_abc123',
        sdkTurnAnchor: 'entry_abc123',
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'pi_turn_anchor',
        sdkMessageId: 'msg_pi_abc123',
        sdkTurnAnchor: 'entry_abc123',
      });
    });

    it('should drop pi_turn_anchor events with missing fields', () => {
      // No sdkTurnAnchor — useless to consumers.
      const e1 = collect(adapter.adaptEvent({
        type: 'pi_turn_anchor',
        sdkMessageId: 'msg_pi_abc123',
      } as any));
      expect(e1).toHaveLength(0);
      // No sdkMessageId — cannot correlate.
      const e2 = collect(adapter.adaptEvent({
        type: 'pi_turn_anchor',
        sdkTurnAnchor: 'entry_abc123',
      } as any));
      expect(e2).toHaveLength(0);
    });

    it('should skip non-assistant message_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'user', content: 'Hello' },
      } as any));
      expect(events).toHaveLength(0);
    });

    it('should skip toolResult message_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'toolResult', content: 'result' },
      } as any));
      expect(events).toHaveLength(0);
    });

    it('should extract text from content array', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [
            { type: 'text', text: 'Part 1' },
            { type: 'text', text: ' Part 2' },
          ],
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('Part 1 Part 2');
    });

    it('should skip message_end with no text content', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'tool_use', id: 'tool1' }],
        },
      } as any));
      expect(events).toHaveLength(0);
    });
  });

  // ============================================================
  // Intermediate vs final text classification
  // ============================================================

  describe('intermediate text classification', () => {
    it('should set isIntermediate: true when stopReason is toolUse', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Let me check that...',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Let me check that...',
        isIntermediate: true,
      });
    });

    it('should set isIntermediate: false when stopReason is stop', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Here is the final answer.',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'text_complete',
        text: 'Here is the final answer.',
        isIntermediate: false,
      });
    });

    it('should allow multiple intermediate messages in a turn', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // First intermediate message
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Let me read the file...',
        },
      } as any));

      // Simulate tool execution between intermediates
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'tool1',
        toolName: 'read',
        args: { path: '/foo.ts' },
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'tool1',
        result: 'file content',
        isError: false,
      } as any));

      // Second intermediate message
      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Now let me check the tests...',
        },
      } as any));

      expect(events1).toHaveLength(1);
      expect(events1[0].isIntermediate).toBe(true);

      expect(events2).toHaveLength(1);
      expect(events2[0].isIntermediate).toBe(true);
    });

    it('should block duplicate final messages in same turn', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // First final message
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Final answer',
        },
      } as any));

      // Duplicate final message (should be blocked)
      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'Duplicate final',
        },
      } as any));

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(0);
    });

    it('should allow final message after tool completion resets state', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Intermediate message
      collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse', content: 'Checking...' },
      } as any));

      // Tool execution
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'tool1',
        toolName: 'read',
        args: {},
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'tool1',
        result: 'output',
        isError: false,
      } as any));

      // Final message after tool — should work because tool_execution_end resets hasEmittedFinalText
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Here is the answer.' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].isIntermediate).toBe(false);
    });
  });

  // ============================================================
  // Sub-turnId isolation
  // ============================================================

  describe('sub-turnId isolation', () => {
    it('should generate unique sub-turnIds for text blocks', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // First text block
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse', content: 'First' },
      } as any));

      // Tool between text blocks
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'read',
        args: {},
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 't1',
        result: 'ok',
        isError: false,
      } as any));

      // Second text block
      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Second' },
      } as any));

      expect(events1[0].turnId).not.toBe(events2[0].turnId);
      expect(events1[0].turnId).toMatch(/^pi-turn-1__m/);
      expect(events2[0].turnId).toMatch(/^pi-turn-1__m/);
    });

    it('should use streaming sub-turnId when deltas preceded text_complete', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Stream deltas first
      const deltaEvents = collect(adapter.adaptEvent({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      } as any));

      // Then text_complete
      const completeEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Hello world' },
      } as any));

      // text_complete should reuse the delta's sub-turnId
      expect(completeEvents[0].turnId).toBe(deltaEvents[0].turnId);
    });

    it('should reset sub-turnId counter across turns', () => {
      // First turn
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events1 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Turn 1' },
      } as any));

      // End turn, start new one
      collect(adapter.adaptEvent({ type: 'turn_end' } as any));
      adapter.startTurn();
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events2 = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Turn 2' },
      } as any));

      // Sub-turn counter resets: both should end with m0
      expect(events1[0].turnId).toBe('pi-turn-1__m0');
      expect(events2[0].turnId).toBe('pi-turn-2__m0');
    });
  });

  // ============================================================
  // Error surfacing
  // ============================================================

  describe('error surfacing', () => {
    it('should emit plain error for unclassified error messages', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Something went wrong internally',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Something went wrong internally',
      });
    });

    it('should emit typed_error for raw HTML proxy pages', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '<html><head><title>400 Bad Request</title></head><body><center><h1>400 Bad Request</h1></center><hr><center>cloudflare</center></body></html>',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect((events[0] as any).error.code).toBe('proxy_error');
      expect((events[0] as any).error.message.toLowerCase()).not.toContain('<html');
    });

    it('should emit typed_error for auth-expiry error messages', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Provided authentication token is expired. Please try signing in again.',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect(events[0].error.code).toBe('expired_oauth_token');
    });

    it('should emit typed_error for 401 unauthorized errors', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '401 Unauthorized',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect(events[0].error.code).toBe('invalid_api_key');
    });

    it('should emit typed_error for billing/402 errors', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '402 Payment required',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('typed_error');
      expect(events[0].error.code).toBe('billing_error');
    });

    // F1.235 — a retryable error (the SDK's own `isRetryableAssistantError`) is
    // PARKED at `message_end`, because the SDK may retry it; the next
    // `agent_end` decides. With `willRetry: false` it surfaces, typed, before
    // the completion — the same event the user saw before, one step later.
    it('should park a rate limit error and emit it as typed_error when the SDK will not retry', () => {
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '429 Too many requests - rate limit exceeded',
        },
      } as any));
      expect(events).toHaveLength(0);

      const released = collect(adapter.adaptEvent({ type: 'agent_end', willRetry: false } as any));
      expect(released.map((event: any) => event.type)).toEqual(['typed_error', 'complete']);
      expect(released[0].error.code).toBe('rate_limited');
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });

    it('should not emit error without errorMessage even if stopReason is error', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          // No errorMessage — fall through to normal text extraction
          content: 'Some partial content',
        },
      } as any));

      // Should emit as text_complete, not error
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('text_complete');
    });
  });

  // ============================================================
  // Tool events
  // ============================================================

  describe('tool events', () => {
    it('accepts only exact advertised piName for live events', () => {
      const manifest = notebookManifest();
      adapter.setExecutionManifest(manifest);
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      expect(() => collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'legacy_live',
        toolName: 'NotebookEdit',
        args: {},
      } as any))).toThrow('not advertised');
      const started = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_manifest',
        toolName: 'notebook_edit',
        args: { path: '/foo.ipynb' },
      } as any));
      const ended = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_manifest',
        result: { content: [{ type: 'text', text: 'done' }] },
        isError: false,
      } as any));

      for (const event of [started[0], ended[0]]) {
        expect(event).toMatchObject({
          toolName: 'NotebookEdit',
          semanticId: 'notebook_edit',
          piName: 'notebook_edit',
          surfaceVersion: 2,
          manifestGeneration: 'generation-events',
          manifestHash: manifest.manifestHash,
        });
        expect(event).not.toHaveProperty('originalName');
      }
      expect(() => collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'unknown',
        toolName: 'Notebook_Edit',
        args: {},
      } as any))).toThrow('not advertised');
    });

    it('should emit tool_start for tool_execution_start', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_123',
        toolName: 'bash',
        args: { command: 'ls -la', description: 'List files' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Bash',
        toolUseId: 'call_123',
        input: { command: 'ls -la', description: 'List files' },
        displayName: 'Run Command',
      });
    });

    it('should fallback to args metadata when store has no entry', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_no_store',
        toolName: 'bash',
        args: {
          command: 'npm test',
          _intent: 'Run unit tests',
          _displayName: 'Run Tests',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Bash',
        toolUseId: 'call_no_store',
        intent: 'Run unit tests',
        displayName: 'Run Tests',
      });
    });

    it('should preserve edits[] for Pi edit tools while deriving legacy diff fields', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_edit',
        toolName: 'edit',
        args: {
          path: '/src/app.ts',
          edits: [
            { oldText: 'const a = 1', newText: 'const a = 2' },
            { oldText: 'const b = 1', newText: 'const b = 2' },
          ],
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Edit',
        toolUseId: 'call_edit',
        input: {
          file_path: '/src/app.ts',
          old_string: 'const a = 1',
          new_string: 'const a = 2',
          edits: [
            { oldText: 'const a = 1', newText: 'const a = 2' },
            { oldText: 'const b = 1', newText: 'const b = 2' },
          ],
        },
      });
    });

    it('should prefer store metadata over args metadata when both exist', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      toolMetadataStore.set('call_store_wins', {
        intent: 'Stored intent',
        displayName: 'Stored name',
        timestamp: Date.now(),
      });

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_store_wins',
        toolName: 'bash',
        args: {
          command: 'npm test',
          _intent: 'Args intent',
          _displayName: 'Args name',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolUseId: 'call_store_wins',
        intent: 'Stored intent',
        displayName: 'Stored name',
      });
    });

    it('should use canonical metadata from event payload', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_canonical',
        toolName: 'bash',
        args: { command: 'npm test' },
        toolMetadata: {
          intent: 'Canonical intent',
          displayName: 'Canonical name',
          source: 'interceptor',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolUseId: 'call_canonical',
        intent: 'Canonical intent',
        displayName: 'Canonical name',
      });
    });

    it('should fallback to base id metadata when toolCallId includes a pipe suffix', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      toolMetadataStore.set('call_base_id', {
        intent: 'Stored base intent',
        displayName: 'Stored base name',
        timestamp: Date.now(),
      });

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_base_id|fc_123',
        toolName: 'bash',
        args: { command: 'npm test' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolUseId: 'call_base_id|fc_123',
        intent: 'Stored base intent',
        displayName: 'Stored base name',
      });
    });

    it('should prefer canonical metadata over store and args', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      toolMetadataStore.set('call_canonical_wins', {
        intent: 'Stored intent',
        displayName: 'Stored name',
        timestamp: Date.now(),
      });

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_canonical_wins',
        toolName: 'bash',
        args: {
          command: 'npm test',
          _intent: 'Args intent',
          _displayName: 'Args name',
        },
        toolMetadata: {
          intent: 'Canonical intent',
          displayName: 'Canonical name',
          source: 'interceptor',
        },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_start',
        toolUseId: 'call_canonical_wins',
        intent: 'Canonical intent',
        displayName: 'Canonical name',
      });
    });

    it('should resolve Pi lowercase tool names to PascalCase', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const toolTests = [
        { piName: 'read', expected: 'Read' },
        { piName: 'write', expected: 'Write' },
        { piName: 'edit', expected: 'Edit' },
        { piName: 'grep', expected: 'Grep' },
        { piName: 'find', expected: 'Find' },
        { piName: 'ls', expected: 'Ls' },
      ];

      for (const { piName, expected } of toolTests) {
        const events = collect(adapter.adaptEvent({
          type: 'tool_execution_start',
          toolCallId: `call_${piName}`,
          toolName: piName,
          args: {},
        } as any));

        expect(events[0].toolName).toBe(expected);
      }
    });

    it('should emit tool_result for tool_execution_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Start tool first
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'read',
        args: { path: '/foo.ts' },
      } as any));

      // End tool
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: { content: [{ type: 'text', text: 'file contents' }] },
        isError: false,
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'call_1',
        toolName: 'Read',
        result: 'file contents',
        isError: false,
      });
      expect(events[0]).not.toHaveProperty('structuredContent');
    });

    it('should preserve structuredContent from tool_execution_end details', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_structured',
        toolName: 'mcp__session__list_sessions',
        args: {},
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_structured',
        result: {
          content: [{ type: 'text', text: 'sessions ready' }],
          details: {
            structuredContent: {
              sessions: [{ id: 's1', title: 'Alpha' }],
            },
          },
        },
        isError: false,
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'call_structured',
        toolName: 'list_sessions',
        semanticId: 'list_sessions',
        piName: 'mcp__session__list_sessions',
        surfaceVersion: 2,
        result: 'sessions ready',
        isError: false,
        structuredContent: {
          sessions: [{ id: 's1', title: 'Alpha' }],
        },
      });
    });

    it('should handle string result in tool_execution_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: 'command output',
        isError: false,
      } as any));

      expect(events[0].result).toBe('command output');
    });

    it('should handle error tool results', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: null,
        isError: true,
      } as any));

      expect(events[0]).toMatchObject({
        type: 'tool_result',
        isError: true,
        result: 'Tool execution failed',
      });
    });

    it('should accumulate partial output from tool_execution_update', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
      } as any));

      // Partial updates
      collect(adapter.adaptEvent({
        type: 'tool_execution_update',
        toolCallId: 'call_1',
        partialResult: { content: [{ type: 'text', text: 'line 1\n' }] },
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_update',
        toolCallId: 'call_1',
        partialResult: { content: [{ type: 'text', text: 'line 2\n' }] },
      } as any));

      // End — should use accumulated output
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: 'ignored because accumulated',
        isError: false,
      } as any));

      expect(events[0].result).toBe('line 1\nline 2\n');
    });

    it('should map a silent-tool heartbeat to elapsed task_progress without accumulating its text', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_update',
        toolCallId: 'call_1',
        partialResult: {
          content: [{ type: 'text', text: 'Still running (30s)' }],
          details: { toolCallHeartbeat: true, elapsedSeconds: 30 },
        },
      } as any));

      expect(events).toEqual([{
        type: 'task_progress',
        toolUseId: 'call_1',
        elapsedSeconds: 30,
        turnId: 'pi-turn-1',
      }]);

      // The heartbeat is liveness, not output: the terminal result is the
      // tool's own, unpolluted by the beat text.
      const end = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: 'real output',
        isError: false,
      } as any));
      expect(end[0].result).toBe('real output');
    });

    it('should emit task_progress from wrapped orchestration details', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const progress: OrchestrationProgress = {
        kind: 'subagent',
        runId: 'subagent-run-1',
        agents: [{
          id: 'subagent-run-1-1',
          label: 'Scout',
          agentType: 'scout',
          status: 'running',
          tokensIn: 12,
          tokensOut: 3,
          lastActivity: 'message_update',
        }],
      };

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_update',
        toolCallId: 'call_1',
        partialResult: { details: { progress } },
      } as any));

      expect(events).toEqual([{
        type: 'task_progress',
        toolUseId: 'call_1',
        orchestrationProgress: progress,
        turnId: 'pi-turn-1',
      }]);
    });

    it('should keep orchestration progress text out of the terminal tool result', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_failed_subagent',
        toolName: 'subagent',
        args: {},
      } as any));
      const progress: OrchestrationProgress = {
        kind: 'subagent',
        runId: 'subagent-run-failed',
        agents: [{
          id: 'agent-failed',
          label: 'worker',
          agentType: 'worker',
          status: 'running',
          tokensIn: 0,
          tokensOut: 0,
        }],
      };

      collect(adapter.adaptEvent({
        type: 'tool_execution_update',
        toolCallId: 'call_failed_subagent',
        partialResult: {
          content: [{ type: 'text', text: 'subagent single progress' }],
          details: { progress },
        },
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_failed_subagent',
        result: {
          content: [{ type: 'text', text: '[ERROR] child failed' }],
          details: {
            result: {
              kind: 'subagent',
              runId: 'subagent-run-failed',
              status: 'error',
              results: [{
                id: 'agent-failed',
                label: 'worker',
                agentType: 'worker',
                status: 'error',
                text: '',
                error: 'child failed',
                tokensIn: 0,
                tokensOut: 0,
              }],
            },
          },
        },
        isError: true,
      } as any));

      expect(events[0]).toMatchObject({
        type: 'tool_result',
        result: '[ERROR] child failed',
        isError: true,
      });
      expect(events[1]).toMatchObject({
        type: 'task_completed',
        taskId: 'subagent-run-failed',
        status: 'failed',
        summary: '[ERROR] child failed',
      });
    });

    it('should emit task_progress from direct orchestration details', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const progress: OrchestrationProgress = {
        kind: 'workflow',
        runId: 'workflow-run-1',
        agents: [{
          id: 'workflow-run-1-1',
          label: 'Review',
          agentType: 'reviewer',
          phase: 'verify',
          status: 'queued',
          tokensIn: 0,
          tokensOut: 0,
        }],
      };

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_update',
        toolCallId: 'call_2',
        partialResult: { details: progress },
      } as any));

      expect(events[0]).toMatchObject({
        type: 'task_progress',
        toolUseId: 'call_2',
        orchestrationProgress: progress,
      });
    });

    it('should ignore malformed orchestration details', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_update',
        toolCallId: 'call_3',
        partialResult: {
          details: {
            progress: {
              kind: 'subagent',
              runId: 'subagent-run-2',
              agents: [{ id: 'subagent-run-2-1', status: 'running' }],
            },
          },
        },
      } as any));

      expect(events).toEqual([]);
    });

    it('should emit task_completed from orchestration result details', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_subagent',
        toolName: 'subagent',
        args: {},
      } as any));

      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_subagent',
        result: {
          content: [{ type: 'text', text: '1. scout - done\nFound files' }],
          details: {
            result: {
              kind: 'subagent',
              runId: 'subagent-run-1',
              status: 'done',
              results: [{
                id: 'subagent-run-1-1',
                label: 'scout',
                agentType: 'scout',
                status: 'done',
                text: 'Found files',
                tokensIn: 2,
                tokensOut: 3,
              }],
            },
          },
        },
        isError: false,
      } as any));

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'call_subagent',
        toolName: 'subagent',
        result: '1. scout - done\nFound files',
      });
      expect(events[1]).toEqual({
        type: 'task_completed',
        taskId: 'subagent-run-1',
        status: 'completed',
        summary: '1. scout - done\nFound files',
        turnId: 'pi-turn-1',
      });
    });

    it('should map orchestration error and aborted results to task_completed statuses', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_workflow_error',
        toolName: 'workflow',
        args: {},
      } as any));
      const failedEvents = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_workflow_error',
        result: {
          content: [{ type: 'text', text: 'workflow failed' }],
          details: {
            result: {
              kind: 'workflow',
              runId: 'workflow-error',
              status: 'error',
              results: [],
            },
          },
        },
        isError: true,
      } as any));

      expect(failedEvents[1]).toMatchObject({
        type: 'task_completed',
        taskId: 'workflow-error',
        status: 'failed',
        summary: 'workflow failed',
      });

      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_workflow_aborted',
        toolName: 'workflow',
        args: {},
      } as any));
      const stoppedEvents = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_workflow_aborted',
        result: {
          content: [{ type: 'text', text: 'workflow stopped' }],
          details: {
            result: {
              kind: 'workflow',
              runId: 'workflow-aborted',
              status: 'aborted',
              results: [],
            },
          },
        },
        isError: false,
      } as any));

      expect(stoppedEvents[1]).toMatchObject({
        type: 'task_completed',
        taskId: 'workflow-aborted',
        status: 'stopped',
        summary: 'workflow stopped',
      });
    });

    it('should use description as intent for bash tools', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'npm test', description: 'Run unit tests' },
      } as any));

      expect(events[0].intent).toBe('Run unit tests');
    });

    it('should classify bash cat commands as Read tool starts', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      const events = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'cat /path/to/file.ts' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].toolName).toBe('Read');
      expect(events[0].displayName).toBe('Read File');
    });

    it('should reset hasEmittedFinalText after tool_execution_end', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // Emit final text
      collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'toolUse', content: 'Checking...' },
      } as any));

      // Tool execution
      collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 't1',
        toolName: 'read',
        args: {},
      } as any));
      collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 't1',
        result: 'ok',
        isError: false,
      } as any));

      // Another text after tool — should succeed
      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Done!' },
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0].text).toBe('Done!');
    });
  });

  // ============================================================
  // Session-level events
  // ============================================================

  describe('session events', () => {
    it('should emit status for compaction_start', () => {
      const events = collect(adapter.adaptEvent({
        type: 'compaction_start',
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'Compacting context...',
      });
    });

    it('should emit info for successful compaction_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: { /* compaction result */ },
        aborted: false,
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'info',
        message: 'Compacted context to fit within limits',
      });
    });

    it('should emit error for failed compaction_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: null,
        aborted: false,
        errorMessage: 'Out of memory',
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: 'Context compaction failed: Out of memory',
      });
    });

    /**
     * TFP1 (2026-10-10): the old stack-shaped compaction error no longer gets
     * its own friendly line. `SDK_AUTOCOMPACT_RACE_SIGNATURE` matched the raw
     * crash of Pi's unguarded `_autoCompactionAbortController.signal` read and
     * said "remove once the upstream fix ships" — the fix shipped in 0.87.1
     * (the `finally` clears only when the field still holds this call's
     * controller; `compaction-failure-surface.test.ts` pins the fixed shape), so
     * the inference is gone and a race-shaped string rides the generic failure
     * line like any other compaction failure.
     */
    it('a race-shaped compaction error rides the generic failure line (the inference is gone)', () => {
      const events = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: null,
        aborted: false,
        errorMessage: "TypeError: undefined is not an object (evaluating 'this._autoCompactionAbortController.signal')",
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'error',
        message: "Context compaction failed: TypeError: undefined is not an object (evaluating 'this._autoCompactionAbortController.signal')",
      });
    });

    it('should emit nothing for aborted compaction', () => {
      const events = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: null,
        aborted: true,
      } as any));

      expect(events).toHaveLength(0);
    });

    /**
     * The gateway ladder is 15/30/60/60/60s (plan 2026-08-07 T1), so the
     * attempt counter alone leaves the user watching a spinner for minutes with
     * no idea how long. The wait and the cause both belong in the line, and
     * "Rate limited" is the keyword SessionManager sniffs for
     * `statusType: 'retrying'`.
     */
    it('should name the cause and the wait for a throttled auto_retry_start', () => {
      const events = collect(adapter.adaptEvent({
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 5,
        delayMs: 30000,
        errorMessage: 'API error: 429 Too Many Requests',
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'Rate limited by the provider — retry 2/5 in 30s',
      });
    });

    /**
     * `auto_retry_start` fires for every error pi-ai classifies retryable —
     * timeouts, 5xx, socket drops (`pi-ai/dist/utils/retry.js`). Claiming a
     * rate limit on those would state a false cause.
     *
     * P6.274 (b) — and WHICH of them it was, in pi-ai's own words. The cause is
     * the first clause of the provider's message, never a category of ours.
     */
    it('should not claim a rate limit for a non-throttle retry', () => {
      const events = collect(adapter.adaptEvent({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 5,
        delayMs: 15000,
        errorMessage: 'fetch failed: socket hang up',
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'Provider error (fetch failed) — retry 1/5 in 15s',
      });
    });

    /**
     * The negative arm of the same line: a retry pi-ai reports with no message
     * at all keeps the bare prefix. An empty parenthesis would be a cause the
     * runtime never named, and the renderer's parser would read it back as one.
     */
    it('should leave the cause out when pi-ai named none', () => {
      const events = collect(adapter.adaptEvent({
        type: 'auto_retry_start',
        attempt: 3,
        maxAttempts: 5,
        delayMs: 60000,
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'Provider error — retry 3/5 in 60s',
      });
    });

    /**
     * F1.299 — this arm used to pin "Retry failed: Max retries exceeded" here, which
     * is the defect: the SDK sends this AFTER the run's final `agent_end
     * { willRetry: false }` had already shown the failure (and, on a fallback-model
     * hop, into the turn the host had re-opened). Nothing holds the turn, so quiet.
     */
    it('should stay quiet on a failed auto_retry_end when no retry holds the turn (F1.299)', () => {
      const events = collect(adapter.adaptEvent({
        type: 'auto_retry_end',
        success: false,
        finalError: 'Max retries exceeded',
      } as any));

      expect(events).toEqual([]);
    });

    it('CONTROL (F1.299) — a failed auto_retry_end while a retry HOLDS the turn still ends it with the parked error', () => {
      adapter.startTurn();
      collect(adapter.adaptEvent({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '503 Service Unavailable', content: [] } } as any));
      collect(adapter.adaptEvent({ type: 'agent_end', messages: [], willRetry: true } as any));
      const events = collect(adapter.adaptEvent({
        type: 'auto_retry_end',
        success: false,
        finalError: 'Retry cancelled',
      } as any));

      expect(events.map(event => event.type)).toEqual(['typed_error', 'complete']);
      expect((events[0] as any).error.code).toBe('service_error');
    });

    /**
     * Without this the last thing the user saw stays "… retry 5/5 in 60s"
     * for the rest of the turn, which reads as still-waiting.
     */
    it('should clear the wait line on a successful auto_retry_end', () => {
      const events = collect(adapter.adaptEvent({
        type: 'auto_retry_end',
        success: true,
        attempt: 2,
      } as any));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'status',
        message: 'Retry succeeded — resuming...',
      });
    });

    it('maps queue and selected session diagnostics without exposing queued prompts', () => {
      const events = collect(adapter.adaptEvent({
        type: 'queue_update',
        steering: ['TOP SECRET prompt'],
        followUp: ['PRIVATE follow-up'],
      } as any));

      expect(events).toEqual([{
        type: 'status',
        message: 'Pi queue updated: 1 steering, 1 follow-up',
      }]);
      expect(JSON.stringify(events)).not.toContain('TOP SECRET');
      expect(JSON.stringify(events)).not.toContain('PRIVATE');

      const sessionInfoEvents = collect(adapter.adaptEvent({
        type: 'session_info_changed',
        name: 'Renamed session',
      } as any));
      expect(sessionInfoEvents).toEqual([{
        type: 'info',
        message: 'Pi session info changed',
      }]);
      expect(JSON.stringify(sessionInfoEvents)).not.toContain('Renamed session');
      expect(collect(adapter.adaptEvent({
        type: 'thinking_level_changed',
        level: 'high',
      } as any))).toEqual([{
        type: 'info',
        message: 'Pi thinking level changed: high',
      }]);
    });

    it('absorbs every Pi 0.83/0.84 session event instead of erroring the turn', () => {
      // Enumerated from the installed `AgentSessionEvent` union
      // (`pi-coding-agent/dist/core/agent-session.d.ts`). The subprocess
      // forwards session events unfiltered and the adapter's `default` arm
      // yields `{type:'error'}`, so an unhandled variant becomes an error
      // banner — `agent_settled` and `entry_appended` fire on every turn.
      const added = [
        { type: 'agent_settled' },
        { type: 'entry_appended', entry: { type: 'message', id: 'e1' } },
        { type: 'bash_execution_update', id: 'call-1', delta: 'SECRET stdout' },
        {
          type: 'summarization_retry_scheduled',
          attempt: 1,
          maxAttempts: 3,
          delayMs: 1000,
          errorMessage: 'transient',
        },
        { type: 'summarization_retry_attempt_start', source: 'compaction', reason: 'threshold' },
        { type: 'summarization_retry_finished' },
      ];

      for (const event of added) {
        const events = collect(adapter.adaptEvent(event as any));
        expect(events, event.type).toEqual([]);
        expect(adapter.shouldCompleteQueue(false), event.type).toBe(false);
      }
    });

    it('fails the active contract on an unknown Pi event without exposing its payload', () => {
      const events = collect(adapter.adaptEvent({
        type: 'future_secret_event',
        prompt: 'DO NOT EXPOSE',
      } as any));

      expect(events).toEqual([{
        type: 'error',
        message: 'Unsupported Pi 0.87.1 event: future_secret_event',
      }]);
      expect(JSON.stringify(events)).not.toContain('DO NOT EXPOSE');
      expect(adapter.shouldCompleteQueue(false)).toBe(true);
    });
  });

  // ============================================================
  // Full multi-turn flow
  // ============================================================

  describe('full multi-turn flow', () => {
    it('should handle intermediate → tool → final message flow', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // 1. Intermediate commentary
      const intermediateEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: 'Let me check the file...',
        },
      } as any));

      // 2. Tool execution
      const toolStartEvents = collect(adapter.adaptEvent({
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'read',
        args: { path: '/src/index.ts' },
      } as any));

      const toolEndEvents = collect(adapter.adaptEvent({
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        result: 'file contents here',
        isError: false,
      } as any));

      // 3. Final response
      const finalEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: 'The file contains your code.',
        },
      } as any));

      // Verify complete flow
      expect(intermediateEvents[0]).toMatchObject({
        type: 'text_complete',
        isIntermediate: true,
        text: 'Let me check the file...',
      });
      expect(toolStartEvents[0]).toMatchObject({
        type: 'tool_start',
        toolName: 'Read',
      });
      expect(toolEndEvents[0]).toMatchObject({
        type: 'tool_result',
        toolName: 'Read',
      });
      expect(finalEvents[0]).toMatchObject({
        type: 'text_complete',
        isIntermediate: false,
        text: 'The file contains your code.',
      });

      // All events should have pi-turn-1 prefix
      expect(intermediateEvents[0].turnId).toMatch(/^pi-turn-1/);
      expect(toolStartEvents[0].turnId).toMatch(/^pi-turn-1/);
      expect(finalEvents[0].turnId).toMatch(/^pi-turn-1/);
    });
  });

  // ============================================================
  // Overflow recovery state machine
  // ============================================================
  //
  // The Pi SDK's _checkCompaction fires _runAutoCompaction("overflow", true)
  // on context_length_exceeded, then agent.continue() to retry. The recovered
  // turn arrives AFTER the original agent_end. The adapter holds the queue
  // open across this flow so the recovered response reaches the UI; if
  // recovery fails or no compaction events arrive, the held error is
  // surfaced and the queue terminates. See plans/fix-pi-gpt-compaction.md.

  describe('overflow recovery', () => {
    const overflowMessage = {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'Your input exceeds the context window of this model. Please adjust your input and try again. (context_length_exceeded)',
    };

    it('success path: holds queue open, surfaces recovered turn, completes once', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      // 1. Overflow message_end — adapter swallows the error.
      const errEvents = collect(adapter.adaptEvent({
        type: 'message_end',
        message: overflowMessage,
      } as any));
      expect(errEvents).toHaveLength(0);

      // 2. Original agent_end — held, no complete yielded, queue stays open.
      const heldAgentEnd = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      expect(heldAgentEnd).toHaveLength(0);
      expect(adapter.shouldCompleteQueue(true)).toBe(false);

      // 3. compaction_start — status surfaces.
      const startEvents = collect(adapter.adaptEvent({ type: 'compaction_start' } as any));
      expect(startEvents).toMatchObject([{ type: 'status', message: 'Compacting context...' }]);

      // 4. compaction_end success — info surfaces, still no complete.
      const endEvents = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: { /* compaction result */ },
        aborted: false,
      } as any));
      expect(endEvents).toMatchObject([{ type: 'info', message: 'Compacted context to fit within limits' }]);
      expect(adapter.shouldCompleteQueue(false)).toBe(false);

      // 5. Recovered text + final agent_end — text_complete + complete arrive.
      const recoveredText = collect(adapter.adaptEvent({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'stop', content: 'Recovered answer' },
      } as any));
      expect(recoveredText).toMatchObject([{ type: 'text_complete', text: 'Recovered answer' }]);

      const finalAgentEnd = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      expect(finalAgentEnd).toMatchObject([{ type: 'complete' }]);
      expect(adapter.shouldCompleteQueue(true)).toBe(true);

      // The original context_length_exceeded never reached the UI.
      const allYields = [...errEvents, ...heldAgentEnd, ...startEvents, ...endEvents, ...recoveredText, ...finalAgentEnd];
      const errorYields = allYields.filter(e => e.type === 'error' || e.type === 'typed_error');
      expect(errorYields).toHaveLength(0);
    });

    it('failure path: drains held overflow with friendly error + complete', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      collect(adapter.adaptEvent({ type: 'message_end', message: overflowMessage } as any));
      collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      collect(adapter.adaptEvent({ type: 'compaction_start' } as any));

      const failureEvents = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: null,
        aborted: false,
        errorMessage: 'Out of memory during summary',
      } as any));

      expect(failureEvents).toEqual([
        { type: 'error', message: 'Context compaction failed: Out of memory during summary' },
        { type: 'complete' },
      ]);
      // Queue should terminate even though the event wasn't agent_end.
      expect(adapter.shouldCompleteQueue(false)).toBe(true);
      // Only one terminal complete — subsequent calls return false.
      expect(adapter.shouldCompleteQueue(false)).toBe(false);
    });

    it('skipped recovery: fallback timer drains held error after timeout', () => {
      jest.useFakeTimers();
      try {
        const enqueued: any[] = [];
        let completed = false;
        adapter.setOverflowFallbackHandlers(
          (event) => enqueued.push(event),
          () => { completed = true; },
        );

        collect(adapter.adaptEvent({ type: 'turn_start' } as any));
        collect(adapter.adaptEvent({ type: 'message_end', message: overflowMessage } as any));
        collect(adapter.adaptEvent({ type: 'agent_end' } as any));

        // No compaction events arrive. Advance past the 5 s fallback timeout.
        jest.advanceTimersByTime(5_000);

        expect(enqueued).toEqual([{ type: 'error', message: overflowMessage.errorMessage }]);
        expect(completed).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it('non-overflow regression: rate-limit error preserves existing behavior', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));

      const events = collect(adapter.adaptEvent({
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'Rate limit exceeded; please try again in 30s',
        },
      } as any));

      // Rate-limit is not an overflow — overflow state stays 'none'. Since
      // F1.235 it is PARKED for the SDK's retry decision rather than shown at
      // once; an agent_end with no retry releases it and completes normally.
      expect(events).toHaveLength(0);

      const agentEndEvents = collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      expect(agentEndEvents.map((event: any) => event.type)).toEqual([expect.stringMatching(/^(error|typed_error)$/), 'complete']);
      expect(adapter.shouldCompleteQueue(true)).toBe(true);
    });

    it('a race-shaped compaction failure still finalizes the held queue, with the generic line (the inference is gone)', () => {
      collect(adapter.adaptEvent({ type: 'turn_start' } as any));
      collect(adapter.adaptEvent({ type: 'message_end', message: overflowMessage } as any));
      collect(adapter.adaptEvent({ type: 'agent_end' } as any));
      collect(adapter.adaptEvent({ type: 'compaction_start' } as any));

      const events = collect(adapter.adaptEvent({
        type: 'compaction_end',
        result: null,
        aborted: false,
        errorMessage: "Auto-compaction failed: undefined is not an object (evaluating 'this._autoCompactionAbortController.signal')",
      } as any));

      // TFP1 (2026-10-10): `SDK_AUTOCOMPACT_RACE_SIGNATURE` used to rewrite this
      // line to "Auto-compaction hit a transient error. Try /compact manually."
      // The upstream fix shipped in 0.87.1 and the inference is removed, so the
      // failure surface is the generic one — but the overflow path must still
      // finalize the held queue exactly as before.
      expect(events).toEqual([
        { type: 'error', message: "Context compaction failed: Auto-compaction failed: undefined is not an object (evaluating 'this._autoCompactionAbortController.signal')" },
        { type: 'complete' },
      ]);
      expect(adapter.shouldCompleteQueue(false)).toBe(true);
    });
  });
});
