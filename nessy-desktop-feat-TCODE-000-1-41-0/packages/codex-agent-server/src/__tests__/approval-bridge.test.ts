/**
 * Task 4.1 gate: approval bridge mappers only ever emit a decision present in
 * the fixed codex approval enum, and map request params to the Nessy request
 * shape. (spike) There is no `availableDecisions` field — the enum is fixed.
 */
import { test, expect, describe } from 'bun:test';
import {
  mapCommandApprovalToRequest,
  mapFileChangeApprovalToRequest,
  resolveDecision,
  isApprovalMethod,
  approvalKindForMethod,
} from '../approval-bridge.ts';

// The shared string members of CommandExecutionApprovalDecision / FileChangeApprovalDecision.
const VALID_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);

describe('approval-bridge', () => {
  test('mapCommandApprovalToRequest builds a shell permission request', () => {
    const req = mapCommandApprovalToRequest('r1', { command: 'ls -la', cwd: '/tmp', reason: 'needs escalation' });
    expect(req).toMatchObject({ requestId: 'r1', toolName: 'shell', command: 'ls -la', reason: 'needs escalation' });
    expect(req.description).toContain('ls -la');
  });

  test('mapFileChangeApprovalToRequest builds an ApplyPatch request', () => {
    const req = mapFileChangeApprovalToRequest('r2', { grantRoot: '/repo', reason: 'write access' });
    expect(req).toMatchObject({ requestId: 'r2', toolName: 'ApplyPatch', reason: 'write access' });
    expect(req.description).toContain('/repo');
  });

  test('resolveDecision maps allow/block/always to a member of the fixed enum', () => {
    for (const kind of ['command', 'fileChange'] as const) {
      const allow = resolveDecision(kind, true);
      const always = resolveDecision(kind, true, true);
      const deny = resolveDecision(kind, false);
      expect(allow).toBe('accept');
      expect(always).toBe('acceptForSession');
      expect(deny).toBe('decline');
      // never emit a decision the schema doesn't define
      expect(VALID_DECISIONS.has(allow)).toBe(true);
      expect(VALID_DECISIONS.has(always)).toBe(true);
      expect(VALID_DECISIONS.has(deny)).toBe(true);
    }
  });

  test('isApprovalMethod / approvalKindForMethod recognize the real methods', () => {
    expect(isApprovalMethod('item/commandExecution/requestApproval')).toBe(true);
    expect(isApprovalMethod('item/fileChange/requestApproval')).toBe(true);
    expect(isApprovalMethod('item/permissions/requestApproval')).toBe(true);
    expect(isApprovalMethod('turn/completed')).toBe(false);
    expect(approvalKindForMethod('item/fileChange/requestApproval')).toBe('fileChange');
    expect(approvalKindForMethod('item/commandExecution/requestApproval')).toBe('command');
  });
});
