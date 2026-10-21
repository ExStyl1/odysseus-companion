/**
 * UA1.18 — the `publish_artifact` / `list_artifacts` handlers carry no approval logic (archive_session's shape): they
 * map the tool input, call the host closure, and turn its verdict into the tool's text. The card, the unattended
 * refusal and the rules are the closure's (`server-core/.../publish-artifact-host-card.test.ts`).
 */
import { describe, expect, test } from 'bun:test';
import type { PublishArtifactInput, PublishArtifactVerdict, SessionToolContext } from '../context.ts';
import { handlePublishArtifact, PUBLISH_ARTIFACT_DESCRIPTION, PublishArtifactSchema } from './publish-artifact.ts';
import { handleListArtifacts, LIST_ARTIFACTS_DESCRIPTION } from './list-artifacts.ts';

function ctxWith(verdict: PublishArtifactVerdict, calls: PublishArtifactInput[] = []): SessionToolContext {
  return {
    publishArtifact: async (input: PublishArtifactInput) => { calls.push(input); return verdict; },
  } as unknown as SessionToolContext;
}

describe('publish_artifact handler', () => {
  test('positive: maps snake_case to the closure input and returns { url, expires_at, updated }', async () => {
    const calls: PublishArtifactInput[] = [];
    const result = await handlePublishArtifact(
      ctxWith({ status: 'updated', note: 'Updated.', url: 'https://t-artifacts.t-tech.team/a/x', expiresAt: null }, calls),
      { file_path: 'a.html', url: 'https://t-artifacts.t-tech.team/a/x', retention_days: 3 },
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(JSON.parse(text)).toEqual({ url: 'https://t-artifacts.t-tech.team/a/x', expires_at: null, updated: true, note: 'Updated.' });
    expect(calls).toEqual([{ filePath: 'a.html', url: 'https://t-artifacts.t-tech.team/a/x', retentionDays: 3 }]);
  });

  test('negative: denied, refused and failed verdicts are errors carrying the host sentence', async () => {
    for (const status of ['denied', 'refused', 'failed'] as const) {
      const result = await handlePublishArtifact(ctxWith({ status, note: `the ${status} sentence` }), { file_path: 'a.html' });
      expect(result.isError, status).toBe(true);
      expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain(`the ${status} sentence`);
    }
  });

  test('negative: no host closure → "not available in this context", nothing else', async () => {
    const result = await handlePublishArtifact({} as SessionToolContext, { file_path: 'a.html' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('publish_artifact is not available in this context.');
  });

  test('the schema accepts a whole-number retention and rejects a string one (the range is the host\'s rule)', () => {
    expect(PublishArtifactSchema.safeParse({ file_path: 'a.html', retention_days: 0 }).success).toBe(true);
    expect(PublishArtifactSchema.safeParse({ file_path: 'a.html', retention_days: '7' }).success).toBe(false);
  });

  test('negative (UA1.20): no file_path → refused with a sentence before the host closure is called', async () => {
    // file_path is optional in the SCHEMA only so a native `Artifact` call without one (`{ action: 'list' }`) reaches
    // the handler and gets the pointer instead of a validation error; the handler still requires it.
    expect(PublishArtifactSchema.safeParse({}).success).toBe(true);
    const calls: PublishArtifactInput[] = [];
    const result = await handlePublishArtifact(ctxWith({ status: 'published', note: 'x' }, calls), {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('publish_artifact needs file_path');
    expect(calls).toEqual([]);
  });

  test('the description names the access model, the expiry and its range, "only when asked", and no command line', () => {
    expect(PUBLISH_ARTIFACT_DESCRIPTION).toContain('ONLY when the user asked in this conversation');
    expect(PUBLISH_ARTIFACT_DESCRIPTION).toContain('the link is the only access control');
    expect(PUBLISH_ARTIFACT_DESCRIPTION).toContain('1 to 30, default 7');
    expect(PUBLISH_ARTIFACT_DESCRIPTION).toContain('confirmation card');
    for (const forbidden of ['npx', 'npm', 'dp auth', 'curl', 'artifact-publish']) {
      expect(PUBLISH_ARTIFACT_DESCRIPTION.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });
});

/**
 * UA1.20 — Claude's native `Artifact` is banned (F1.253) and ALIASED onto `mcp__session__publish_artifact`, so a call a
 * skill document or the model's habit emits arrives here in the native `ArtifactInput` shape (vendored
 * `sdk-tools.d.ts`, claudeCodeVersion 2.1.274). The field-by-field classification against that file is pinned in
 * `packages/shared/src/agent/__tests__/claude-tool-aliases.test.ts`; these arms drive the shape through the same
 * zod parse the SDK's in-process `tool()` applies and into the handler.
 */
describe('publish_artifact handler — the native Artifact shape (UA1.20)', () => {
  const NATIVE_PUBLISH = {
    action: 'publish',
    file_path: 'report.html',
    favicon: '📊',
    title: 'Q3 report',
    description: 'One line.',
    url: 'https://t-artifacts.t-tech.team/a/abc',
    // claude.ai-service knobs with no t-artifacts meaning: accepted and dropped.
    label: 'Draft to legal',
    icon: 'chart',
    force: true,
    capabilities: { db: {} },
    contract: 'latest',
  };

  test('positive: a native-shape publish validates, maps favicon → emoji, drops the claude.ai knobs, and reaches the host closure', async () => {
    const parsed = PublishArtifactSchema.safeParse(NATIVE_PUBLISH);
    expect(parsed.success).toBe(true);
    const args = (parsed as { data: Record<string, unknown> }).data;
    for (const dropped of ['label', 'icon', 'force', 'capabilities', 'contract']) {
      expect(Object.prototype.hasOwnProperty.call(args, dropped), dropped).toBe(false);
    }
    const calls: PublishArtifactInput[] = [];
    const result = await handlePublishArtifact(
      ctxWith({ status: 'published', note: 'Published.', url: 'https://t-artifacts.t-tech.team/a/abc', expiresAt: '2026-10-09T00:00:00Z' }, calls),
      args,
    );
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([{
      filePath: 'report.html',
      title: 'Q3 report',
      description: 'One line.',
      emoji: '📊',
      url: 'https://t-artifacts.t-tech.team/a/abc',
    }]);
  });

  test('positive: an omitted action is a publish; emoji wins over favicon when both are given', async () => {
    const calls: PublishArtifactInput[] = [];
    await handlePublishArtifact(ctxWith({ status: 'published', note: 'x' }, calls), { file_path: 'a.md', emoji: '📄', favicon: '📊' });
    expect(calls).toEqual([{ filePath: 'a.md', emoji: '📄' }]);
  });

  test('negative: every other native action — and a delete of any spelling — is refused with the list_artifacts pointer, and the host is never called', async () => {
    for (const action of ['list', 'read', 'list_types', 'watch', 'unwatch', 'status', 'upload_asset', 'list_assets', 'read_asset', 'delete_asset', 'delete', 'DELETE', 'Publish', '']) {
      const calls: PublishArtifactInput[] = [];
      const result = await handlePublishArtifact(
        ctxWith({ status: 'published', note: 'x', url: 'u' }, calls),
        { action, file_path: 'a.html', url: 'https://t-artifacts.t-tech.team/a/abc' },
      );
      const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
      expect(result.isError, action).toBe(true);
      expect(text, action).toContain('list_artifacts');
      expect(text, action).toContain('nothing was sent, read or deleted');
      expect(calls, action).toEqual([]);
    }
  });

  test('negative: a url on another origin is handed to the host unchanged, whose origin check refuses it before any request', async () => {
    // The refusal itself is the host's (`artifact-publishing.ts`, `isTArtifactsUrl` → "not a page this workspace
    // published"; pinned by the claude.ai arm of `server-core/.../artifact-publish-flow.test.ts`). The handler must not
    // rewrite the link onto the t-artifacts origin, which would turn a claude.ai URL into an update target.
    const calls: PublishArtifactInput[] = [];
    await handlePublishArtifact(ctxWith({ status: 'refused', note: 'not a page this workspace published' }, calls), {
      action: 'publish', file_path: 'a.html', url: 'https://claude.ai/artifact/abc',
    });
    expect(calls).toEqual([{ filePath: 'a.html', url: 'https://claude.ai/artifact/abc' }]);
  });
});

describe('list_artifacts handler', () => {
  test('positive: returns the closure rows as JSON', async () => {
    const ctx = { listArtifacts: () => ({ artifacts: [{ id: 'x', title: 'T', url: 'u', expiresAt: null }] }) } as unknown as SessionToolContext;
    const result = await handleListArtifacts(ctx, {});
    expect(JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : '{}')).toEqual({
      artifacts: [{ id: 'x', title: 'T', url: 'u', expiresAt: null }],
    });
  });

  test('negative: no host closure → unavailable; the description says other sessions\' pages are not listed', async () => {
    const result = await handleListArtifacts({} as SessionToolContext, {});
    expect(result.isError).toBe(true);
    expect(LIST_ARTIFACTS_DESCRIPTION).toContain('Pages published from other sessions are not listed');
  });
});
