import { describe, expect, it } from 'bun:test';
import { proxyExecutionResultToAgentToolResult } from './proxy-tool-result.ts';

describe('proxyExecutionResultToAgentToolResult', () => {
  it('delivers structuredContent on the model-facing tool result details', () => {
    const result = proxyExecutionResultToAgentToolResult({
      content: 'rows ready',
      isError: false,
      structuredContent: {
        rows: [{ id: 1, label: 'alpha' }],
      },
    });

    expect(result.content).toEqual([{ type: 'text', text: 'rows ready' }]);
    expect(result.details).toEqual({
      structuredContent: {
        rows: [{ id: 1, label: 'alpha' }],
      },
    });
  });

  it('keeps text-only tool results unchanged', () => {
    const result = proxyExecutionResultToAgentToolResult({
      content: 'plain text',
      isError: false,
    });

    expect(result.content).toEqual([{ type: 'text', text: 'plain text' }]);
    expect(result.details).toEqual({});
  });

  /**
   * P6.617 — P6.345's Pi residue. The claude adapter and the MCP route both
   * merge `extraContent`; this direct sidecar route dropped it, so one registry
   * tool answered differently depending on which route reached it.
   */
  it('appends an image after the text, because Pi content already accepts one', () => {
    const image = { type: 'image' as const, data: 'aGk=', mimeType: 'image/png' };
    const result = proxyExecutionResultToAgentToolResult({
      content: 'chart ready',
      isError: false,
      extraContent: [image],
    });

    // AFTER the text, the same order the other three adapters use.
    expect(result.content).toEqual([{ type: 'text', text: 'chart ready' }, image]);
    // Nothing sidecarred: an image has a home in `content`.
    expect(result.details).toEqual({});
  });

  it('sidecars a resource block rather than dropping it, since Pi content has no member for one', () => {
    const resource = {
      type: 'resource' as const,
      resource: { uri: 'file:///report.csv', mimeType: 'text/csv', text: 'a,b\n1,2' },
    };
    const result = proxyExecutionResultToAgentToolResult({
      content: 'report attached',
      isError: false,
      extraContent: [resource],
    });

    expect(result.content).toEqual([{ type: 'text', text: 'report attached' }]);
    expect(result.details).toEqual({ extraContent: [resource] });
  });

  it('leaves an empty extraContent indistinguishable from none', () => {
    // The negative that keeps the field honest: a tool that sets the array and
    // fills nothing must produce exactly the text-only result above, not an
    // empty `extraContent` key the renderer has to special-case.
    const result = proxyExecutionResultToAgentToolResult({
      content: 'plain text',
      isError: false,
      extraContent: [],
    });

    expect(result.content).toEqual([{ type: 'text', text: 'plain text' }]);
    expect(result.details).toEqual({});
  });
});
