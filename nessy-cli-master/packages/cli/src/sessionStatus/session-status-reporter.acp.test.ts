/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Session } from '../acp-integration/session/Session.js';
import type { Config } from '@nestor/nessy-cli-core';
import { writeRuntimeStatus } from '@nestor/nessy-cli-core';
import type { AgentSideConnection } from '@agentclientprotocol/sdk';
import type { LoadedSettings } from '../config/settings.js';

/**
 * MR3: ACP-режим пишет фазы сессии в runtime.json тем же SessionStatusReporter,
 * что и TUI. Здесь проверяется проводка на уровне Session: стартовая запись
 * idle, перевод в waiting_input на время session/request_permission с полным
 * pending_request и возврат в working после ответа.
 *
 * Полный цикл working/done метода prompt() требует всего turn-machinery —
 * он покрыт ручной/E2E-проверкой; unit-уровень проверяет репортёр-обёртку.
 */

describe('Session (ACP) session-status reporting', () => {
  let tmpDir: string;
  let runtimePath: string;
  let autoSessionControl: boolean;
  let requestPermissionImpl: (
    params: unknown,
  ) => Promise<{ outcome: { outcome: string; optionId: string } }>;
  let mockConfig: Config;
  let mockClient: AgentSideConnection;
  let session: Session;

  /**
   * readRuntimeStatus сознательно не возвращает state-блок (только базовые
   * поля) — внешние потребители (Swift-нотификатор, Desktop Pet) парсят
   * файл целиком. Тест делает так же.
   */
  const readRaw = () => {
    // The base sidecar is written asynchronously by the Session ctor —
    // missing file is a normal intermediate state, not an error.
    try {
      return JSON.parse(fs.readFileSync(runtimePath, 'utf-8')) as {
        state?: {
          phase?: string;
          source?: string;
          pending_request?: {
            request_id?: string;
            tool_name?: string;
            summary?: string;
            options?: Array<{ option_id: string; name: string }>;
          } | null;
          control?: unknown;
        };
      };
    } catch {
      return {} as { state?: undefined };
    }
  };

  const waitForPhase = async (
    predicate: (raw: ReturnType<typeof readRaw>) => boolean,
    timeoutMs = 2000,
  ): Promise<ReturnType<typeof readRaw>> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const raw = readRaw();
      if (predicate(raw)) return raw;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for runtime.json state; last: ${JSON.stringify(raw.state)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  const readState = () => readRaw().state ?? null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nessy-acp-status-'));
    runtimePath = path.join(tmpDir, 'chats', 'acp-session-1.runtime.json');
    autoSessionControl = true;
    requestPermissionImpl = vi.fn().mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
    });

    // Базовый сайдкар НЕ сиживается вручную: Session обязан создать его сам
    // (ACP-режим не проходит через TUI-bootstrap) — иначе state-merge молча
    // отбрасывается и весь MR3 мёртв. Тест это и проверяет.

    mockConfig = {
      getAutoSessionControl: () => autoSessionControl,
      getTargetDir: () => '/tmp/project',
      storage: {
        getRuntimeStatusPath: () => runtimePath,
      },
      getBackgroundTaskRegistry: () => ({
        setNotificationCallback: vi.fn(),
      }),
      getMonitorRegistry: () => ({
        setNotificationCallback: vi.fn(),
      }),
      getBackgroundShellRegistry: () => ({
        setNotificationCallback: vi.fn(),
      }),
      getChatRecordingService: () => ({
        setTitleRecordedCallback: vi.fn(),
      }),
    } as unknown as Config;

    mockClient = {
      requestPermission: (params: unknown) => requestPermissionImpl(params),
    } as unknown as AgentSideConnection;

    const mockSettings = {
      merged: {},
    } as unknown as LoadedSettings;

    session = new Session(
      'acp-session-1',
      mockConfig,
      mockClient,
      mockSettings,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes the initial idle phase to runtime.json when enabled', async () => {
    const status = await waitForPhase((s) => s.state?.phase === 'idle');
    expect(status.state?.pending_request).toBeNull();
    expect(status.state?.control).toBeNull();
    // ACP-режим штампует source: внешние наблюдатели классифицируют сессию
    // без ps (которого нет на Windows).
    expect(status.state?.source).toBe('acp');
  });

  it('creates no state block when autoSessionControl is disabled', async () => {
    // Свой конфиг и файл для второй сессии: мутировать ОБЩИЙ mockConfig
    // нельзя — boot-IIFE сессии из beforeEach резолвит свой путь в момент
    // записи и уехал бы в этот файл.
    const runtimePath2 = path.join(
      tmpDir,
      'chats',
      'acp-session-2.runtime.json',
    );
    await writeRuntimeStatus(runtimePath2, {
      sessionId: 'acp-session-2',
      workDir: '/tmp/project',
    });
    const mockConfig2 = {
      ...mockConfig,
      getAutoSessionControl: () => false,
      storage: { getRuntimeStatusPath: () => runtimePath2 },
    } as unknown as Config;
    const session2 = new Session('acp-session-2', mockConfig2, mockClient, {
      merged: {},
    } as unknown as LoadedSettings);
    expect(session2.getId()).toBe('acp-session-2');
    // Даём очередь записей время осушиться — state остаётся отсутствующим.
    await new Promise((r) => setTimeout(r, 100));
    expect(
      (
        JSON.parse(fs.readFileSync(runtimePath2, 'utf-8')) as {
          state?: unknown;
        }
      ).state,
    ).toBeUndefined();
  });

  it('reports waiting_input with full pending_request while the client deliberates', async () => {
    await waitForPhase((s) => s.state?.phase === 'idle');

    // WHEN: клиент задумался над permission-запросом
    let resolveClient!: (value: {
      outcome: { outcome: string; optionId: string };
    }) => void;
    requestPermissionImpl = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveClient = resolve;
      }),
    );

    const pending = session.requestPermission({
      sessionId: 'acp-session-1',
      options: [
        { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Reject', kind: 'reject_once' },
      ],
      toolCall: {
        toolCallId: 'call-1',
        status: 'pending',
        title: 'Write file /tmp/project/x.txt',
        kind: 'edit',
        rawInput: {},
        _meta: { toolName: 'write_file' },
      },
    });
    void pending.catch(() => undefined);

    // THEN: waiting_input с деталями запроса в формате MR1
    const waiting = await waitForPhase(
      (s) => s.state?.phase === 'waiting_input',
    );
    const request = waiting.state?.pending_request;
    expect(request).toBeDefined();
    expect(request?.tool_name).toBe('write_file');
    expect(request?.summary).toBe('Write file /tmp/project/x.txt');
    expect(request?.options).toEqual([
      { option_id: 'proceed_once', name: 'Allow' },
      { option_id: 'cancel', name: 'Reject' },
    ]);
    expect(request?.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // WHEN: клиент ответил — сессия возвращается в working (ход продолжается)
    resolveClient({
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
    });
    await pending;
    await waitForPhase((s) => s.state?.phase === 'working');
    expect((await readState())?.pending_request).toBeNull();
  });

  it('restores working after a failed permission request', async () => {
    await waitForPhase((s) => s.state?.phase === 'idle');

    requestPermissionImpl = vi.fn().mockRejectedValue(new Error('client gone'));

    await expect(
      session.requestPermission({
        sessionId: 'acp-session-1',
        options: [
          { optionId: 'proceed_once', name: 'Allow', kind: 'allow_once' },
        ],
        toolCall: {
          toolCallId: 'call-2',
          status: 'pending',
          title: 'Run shell echo',
          kind: 'execute',
          rawInput: {},
          _meta: { toolName: 'run_shell_command' },
        },
      }),
    ).rejects.toThrow('client gone');

    await waitForPhase((s) => s.state?.phase === 'working');
  });
});
