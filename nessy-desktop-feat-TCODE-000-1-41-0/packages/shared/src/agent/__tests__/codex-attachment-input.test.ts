/**
 * P6.28 / P3.101 — a composer attachment on the codex backend.
 *
 * `CodexAgent.chatImpl` took `_attachments` and never read it, so an image
 * dropped into the composer stopped at this adapter: the model never saw it,
 * and `modelSupportsImages` answering `true` unconditionally for
 * `codex-runtime` meant `filterAttachmentsForModelInput` never fired either —
 * the turn proceeded, nothing on screen was wrong, and the answer was reached
 * without the picture. Positive control on the same rig when that was measured:
 * `grep -a -ci attach` scored 7 in `codex-agent.ts` against 24 in `pi-agent.ts`
 * and 58 in `claude-agent.ts`.
 *
 * Codex already had the mechanism, which is what makes this configuration
 * rather than construction: `TurnStartParams.input` is `UserInput[]`, a
 * SEVEN-member union, and we sent exactly one member. `LocalImageUserInput` is
 * `{ type: 'localImage', path }` — a path, not base64 — verified at HEAD in
 * `codex-protocol/schema/v2/TurnStartParams.json` and the bindings
 * `codex-protocol/generated/v2/UserInput.ts`, both generated from the
 * `rust-v0.148.0` tag `codex-protocol/manifest.json` pins the bundled binary to.
 *
 * Three things are pinned here, and the third is the one that survives if the
 * wire ever changes: the SEND (a real `localImage` member rides `turn/start`),
 * the POINTER (every attachment still contributes the `[Attached …]` text
 * Claude and Pi both emit, so a non-image is no longer invisible either), and
 * the HONEST LOSS — an image this adapter cannot carry produces a `warning`
 * event instead of silence.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import type { FileAttachment } from '../../utils/files.ts';
import type { SessionKey } from '../../sessions/session-key.ts';
import { cleanupModeState } from '../mode-manager.ts';
import { CodexAgent, buildCodexAttachmentInput } from '../codex-agent.ts';

const WORKSPACE_ID = 'ws-codex-attachments';
const SESSION_ID = 'session-codex-attachments';
const SESSION_KEY: SessionKey = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Attachment Workspace',
      rootPath: '/tmp/ws-codex-attachments-root',
      workspaceRootPath: '/tmp/ws-codex-attachments-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-attachments',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-codex-attachments-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

function imageAttachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    type: 'image',
    path: '/abs/original/screenshot.png',
    name: 'screenshot.png',
    mimeType: 'image/png',
    size: 70,
    ...overrides,
  };
}

/** Stand in for the app-server: record every request, settle each turn. */
function stubTransport(agent: CodexAgent): Array<{ method: string; params: any }> {
  const requests: Array<{ method: string; params: any }> = [];
  const client = {
    request(method: string, params: any) {
      requests.push({ method, params });
      if (method === 'turn/start') {
        queueMicrotask(() => (agent as any).handleNotification('turn/completed', {}));
      }
      return Promise.resolve({ thread: { id: 'thread-1' } });
    },
    notify() {},
    close() {},
  };
  (agent as any).ensureRuntime = async () => {
    (agent as any).client = client;
    (agent as any).threadId = 'thread-1';
  };
  return requests;
}

async function drain(
  agent: CodexAgent,
  prompt: string,
  attachments?: FileAttachment[],
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of (agent as any).chatImpl(prompt, attachments)) {
    events.push(event as AgentEvent);
  }
  return events;
}

function turnStart(requests: Array<{ method: string; params: any }>): any {
  return requests.find(entry => entry.method === 'turn/start')?.params;
}

describe('buildCodexAttachmentInput', () => {
  it('emits codex\'s own localImage member for an image whose file is on disk', () => {
    const result = buildCodexAttachmentInput(
      [imageAttachment({ storedPath: '/abs/session/attachments/id_screenshot.png' })],
      () => true,
    );

    // A PATH, not base64 — the whole reason this is configuration-shaped.
    expect(result.images).toEqual([
      { type: 'localImage', path: '/abs/session/attachments/id_screenshot.png' },
    ]);
    expect(result.uncarriedImages).toEqual([]);
    // …and the pointer text rides alongside, exactly as it does on Claude and Pi.
    expect(result.pathParts).toEqual([
      '[Attached image: screenshot.png]\n[Stored at: /abs/session/attachments/id_screenshot.png]',
    ]);
  });

  it('prefers the stored path over the original — that is the resized file codex should read', () => {
    const result = buildCodexAttachmentInput(
      [imageAttachment({ storedPath: '/abs/session/attachments/id_screenshot.png' })],
      () => true,
    );
    expect(result.images[0]!.path).toBe('/abs/session/attachments/id_screenshot.png');
    expect(result.images[0]!.path).not.toBe('/abs/original/screenshot.png');
  });

  it('carries a non-image attachment as a path pointer and never as an image member', () => {
    const result = buildCodexAttachmentInput(
      [
        {
          type: 'office',
          path: '/abs/original/spec.docx',
          storedPath: '/abs/session/attachments/id_spec.docx',
          markdownPath: '/abs/session/attachments/id_spec.docx.md',
          name: 'spec.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 2048,
        },
      ],
      () => true,
    );

    expect(result.images).toEqual([]);
    expect(result.uncarriedImages).toEqual([]);
    expect(result.pathParts).toEqual([
      '[Attached file: spec.docx]\n[Stored at: /abs/session/attachments/id_spec.docx]'
        + '\n[Markdown version: /abs/session/attachments/id_spec.docx.md]',
    ]);
  });

  it('classifies by mime type too, so an image with an unclassified `type` is not missed', () => {
    const result = buildCodexAttachmentInput(
      [imageAttachment({ type: 'unknown', storedPath: '/abs/session/a.webp', mimeType: 'image/webp' })],
      () => true,
    );
    expect(result.images).toHaveLength(1);
  });

  it('reports an image whose file is missing rather than sending a path codex cannot open', () => {
    const result = buildCodexAttachmentInput(
      [imageAttachment({ storedPath: '/abs/session/attachments/gone.png' })],
      () => false,
    );

    expect(result.images).toEqual([]);
    expect(result.uncarriedImages).toEqual(['screenshot.png']);
    // The pointer still goes out: the model is told what was attached and where
    // it was meant to be, which is what makes the loss diagnosable.
    expect(result.pathParts).toHaveLength(1);
  });

  it('refuses a relative path — it would resolve against the app-server\'s cwd, not ours', () => {
    const result = buildCodexAttachmentInput(
      [imageAttachment({ path: 'screenshot.png', storedPath: undefined })],
      () => true,
    );

    expect(result.images).toEqual([]);
    expect(result.uncarriedImages).toEqual(['screenshot.png']);
  });

  /**
   * P3.126 — audio is DECLINED on codex, not missing, and this pins the shape of
   * the decline so a future widening has to be deliberate.
   *
   * Codex is the only one of the three that COULD carry it (`UserInput::LocalAudio
   * { path }` at `rust-v0.148.0`; Anthropic Messages has no audio content block
   * and pi-ai's `input` is `("text"|"image")[]` — 0.84.2, re-read unchanged at
   * 0.84.3 by W11-pi 2026-09-11), and the reasons it is
   * not carried are recorded once on `buildCodexAttachmentInput` itself.
   *
   * `uncarriedImages` staying EMPTY is the load-bearing half. That list feeds the
   * "we could not send this" notice, and an audio file is not a failed image —
   * reporting it there would tell the user something went wrong with a decision
   * that was made on purpose.
   */
  it('declines audio deliberately: a pointer, no image member, and no uncarried report', () => {
    const result = buildCodexAttachmentInput(
      [
        {
          type: 'audio',
          path: '/abs/original/voice.ogg',
          storedPath: '/abs/session/attachments/id_voice.ogg',
          name: 'voice.ogg',
          mimeType: 'audio/ogg',
          size: 4096,
          base64: 'ZmFrZQ==',
        },
      ],
      () => true,
    );

    expect(result.images).toEqual([]);
    expect(result.uncarriedImages).toEqual([]);
    // P3.364 · the pointer now says the contents are not available. `audio` was
    // ALREADY in this state — declined on purpose, with the decision recorded on
    // the builder — and the line below is that decision reaching the model
    // instead of only the docblock. `uncarriedImages` still stays empty: an
    // audio file is not a failed image, and the report it belongs to is
    // `uncarriedDocuments`.
    expect(result.pathParts).toEqual([
      '[Attached file: voice.ogg]\n[Stored at: /abs/session/attachments/id_voice.ogg]'
      + '\n[Contents NOT available: this runtime carries the path only, and this file is not readable as text.]',
    ]);
    expect(result.uncarriedDocuments).toEqual(['voice.ogg']);
  });

  /**
   * P3.364 — the row's own case. A PDF's bytes reach the model on claude
   * (`claude-agent.ts` emits a real `document`/base64 block) and on neither
   * other runtime, and until this row NO channel said so: the model-input filter
   * omits only images, the uncarried-attachment warning named images only, the
   * pre-send composer check is image-only, and the capability model has no
   * document axis at all.
   *
   * KILLS the silent state: a PDF that arrives as a bare path with nothing
   * saying the bytes did not.
   */
  it('reports a PDF as uncarried and says so in the pointer', () => {
    const result = buildCodexAttachmentInput(
      [
        {
          type: 'pdf',
          path: '/abs/original/spec.pdf',
          storedPath: '/abs/session/attachments/id_spec.pdf',
          name: 'spec.pdf',
          mimeType: 'application/pdf',
          size: 91_000,
        },
      ],
      () => true,
    );
    expect(result.images).toEqual([]);
    expect(result.uncarriedImages).toEqual([]);
    expect(result.uncarriedDocuments).toEqual(['spec.pdf']);
    expect(result.pathParts[0]).toContain('[Contents NOT available:');
  });

  /**
   * The office pair, which is the whole reason the predicate is not "not an
   * image": a converted office file HAS readable contents, at a path the pointer
   * already names, so warning about it would be false.
   */
  it('distinguishes an office file with a markdown twin from one without', () => {
    const base = {
      type: 'office' as const,
      path: '/abs/original/notes.docx',
      storedPath: '/abs/session/attachments/id_notes.docx',
      name: 'notes.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 12_000,
    };
    const converted = buildCodexAttachmentInput(
      [{ ...base, markdownPath: '/abs/session/attachments/id_notes.md' }],
      () => true,
    );
    expect(converted.uncarriedDocuments).toEqual([]);
    expect(converted.pathParts[0]).toContain('[Markdown version:');
    expect(converted.pathParts[0]).not.toContain('[Contents NOT available:');

    const unconverted = buildCodexAttachmentInput([base], () => true);
    expect(unconverted.uncarriedDocuments).toEqual(['notes.docx']);
    expect(unconverted.pathParts[0]).toContain('[Contents NOT available:');
  });

  /**
   * NEGATIVE CONTROLS. A text file's pointer IS sufficient — the model reads it
   * — and `unknown` is deliberately excluded because it is what the classifier
   * answers for an unrecognised extension, most often a text file; a warning
   * that fires on a readable file trains the reader to ignore the family. The
   * residue (an undecodable `unknown` still costs one wasted Read) is recorded
   * on the predicate.
   */
  it('says nothing about a text attachment, or about an unclassified one', () => {
    const result = buildCodexAttachmentInput(
      [
        { type: 'text', path: '/a/notes.txt', storedPath: '/s/notes.txt', name: 'notes.txt', mimeType: 'text/plain', size: 10 },
        { type: 'unknown', path: '/a/thing.bin', storedPath: '/s/thing.bin', name: 'thing.bin', mimeType: 'application/octet-stream', size: 10 },
      ],
      () => true,
    );
    expect(result.uncarriedDocuments).toEqual([]);
    expect(result.pathParts.join('\n')).not.toContain('[Contents NOT available:');
  });

  it('is a no-op on a turn with no attachments', () => {
    expect(buildCodexAttachmentInput(undefined, () => true))
      .toEqual({ pathParts: [], images: [], uncarriedImages: [], uncarriedDocuments: [] });
  });
});

describe('CodexAgent turn/start carries the attachment', () => {
  afterEach(() => cleanupModeState(SESSION_KEY));

  it('sends a localImage member beside the text, and the text keeps its shape', async () => {
    cleanupModeState(SESSION_KEY);
    const dir = mkdtempSync(join(tmpdir(), 'codex-attach-'));
    const stored = join(dir, 'screenshot.png');
    writeFileSync(stored, 'not-really-a-png');

    const agent = new CodexAgent(createConfig());
    const requests = stubTransport(agent);

    const events = await drain(agent, 'what is in this screenshot?', [
      imageAttachment({ storedPath: stored }),
    ]);

    const params = turnStart(requests);
    // Two members now, and the text is still first — every existing reader
    // asserts on `input[0].text`.
    expect(params.input).toHaveLength(2);
    expect(params.input[0].type).toBe('text');
    expect(params.input[1]).toEqual({ type: 'localImage', path: stored });
    // The pointer sits between the host's context and the user's own words,
    // which is Claude's order (`buildSDKUserMessage`) and Pi's.
    const text = params.input[0].text as string;
    expect(text).toContain(`[Attached image: screenshot.png]\n[Stored at: ${stored}]`);
    expect(text.endsWith('what is in this screenshot?')).toBe(true);
    expect(text.indexOf('[Attached image:')).toBeLessThan(text.indexOf('what is in this screenshot?'));
    // Nothing was reported lost, because nothing was.
    expect(events.filter(e => e.type === 'info')).toHaveLength(0);

    agent.destroy();
  });

  it('says so when it cannot carry the image, instead of proceeding in silence', async () => {
    cleanupModeState(SESSION_KEY);
    const agent = new CodexAgent(createConfig());
    const requests = stubTransport(agent);

    const events = await drain(agent, 'describe it', [
      imageAttachment({ storedPath: '/abs/session/attachments/definitely-not-here.png' }),
    ]);

    const params = turnStart(requests);
    expect(params.input).toHaveLength(1);

    const warning = events.find(
      (e): e is Extract<AgentEvent, { type: 'info' }> => e.type === 'info',
    );
    expect(warning).toBeDefined();
    expect(warning!.level).toBe('warning');
    expect(warning!.message).toContain('screenshot.png');
    expect(warning!.message).toContain('not sent to the model');

    agent.destroy();
  });
});
