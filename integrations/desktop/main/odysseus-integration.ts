/** Optional composition layer. Standalone Nessy remains independent of Odysseus. */
import { app, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { HandlerDeps } from './handlers/handler-deps';
import { fork, execFile, type ChildProcess } from 'node:child_process';
import { openOdysseusTerminal } from './odysseus-terminal';
import { getCredentialManager } from '@nessy-agent/shared/credentials';

// The launcher supplies a trusted installation path, never the renderer.
const importLocal = new Function('url', 'return import(url)') as (url: string) => Promise<any>;
let registered = false;
export function registerOdysseusIntegration(deps: HandlerDeps): void {
  if (registered) return;
  registered = true;
  const root = process.env.ODYSSEUS_ROOT && resolve(process.env.ODYSSEUS_ROOT);
  let status: any = { enabled: Boolean(root), running: false };
  let bridge: any, store: any, secrets: any, paths: any, pending: Promise<any> | undefined;
  let worker: ChildProcess | undefined,
    sequence = 0;
  const requests = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const ready = root
    ? Promise.all(
        ['personal-sync', 'personal-store', 'personal-secrets'].map((name) =>
          importLocal(pathToFileURL(join(root, 'tools', `${name}.mjs`)).href),
        ),
      ).then(([b, s, k]) => {
        bridge = b;
        store = s;
        secrets = k;
        paths = b.personalPaths(root);
      })
    : Promise.resolve();
  function trusted(event: IpcMainInvokeEvent): string {
    const workspaceId = deps.windowManager?.getWorkspaceForWindow(event.sender.id);
    if (event.senderFrame !== event.sender.mainFrame || !workspaceId)
      throw new Error('Untrusted application window');
    return workspaceId;
  }
  function backgroundSync(protectedDesktop: string[], settleMs: number): Promise<any> {
    const node = process.env.ODYSSEUS_NODE;
    if (!node || !root) return Promise.reject(new Error('Missing Odysseus launcher'));
    if (!worker?.connected) {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      worker = fork(join(root, 'tools/personal-worker.mjs'), [root], {
        execPath: node,
        env,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      worker.on('message', (message: any) => {
        const request = requests.get(message?.id);
        if (!request) return;
        clearTimeout(request.timer);
        requests.delete(message.id);
        if (message.error) request.reject(new Error('Background synchronization failed'));
        else request.resolve(message);
      });
      const fail = () => {
        for (const request of requests.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('Background synchronizer exited'));
        }
        requests.clear();
        worker = undefined;
      };
      worker.once('error', fail);
      worker.once('exit', fail);
    }
    const id = ++sequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        requests.delete(id);
        worker?.kill();
        reject(new Error('Background sync timed out'));
      }, 60000);
      requests.set(id, { resolve: resolveRequest, reject, timer });
      worker!.send({ type: 'sync', id, protectedDesktop, settleMs }, (error) => {
        if (error) {
          clearTimeout(timer);
          requests.delete(id);
          reject(error);
        }
      });
    });
  }
  async function synchronize(settleMs = 2000): Promise<any> {
    if (!root) return status;
    if (pending) return pending;
    pending = (async () => {
      await ready;
      await deps.sessionManager.waitForInit();
      status = { ...status, running: true };
      // Avoid getSessions(): its UI projection loads workspace config for every session.
      await deps.sessionManager.flushOdysseusIdleSessions();
      const protectedSessions = deps.sessionManager.getOdysseusProtectedSessions();
      bridge.writeDesktopLease(paths, protectedSessions);
      const { result, sharedChanges, modelsChanged, preferences } = await backgroundSync(
        protectedSessions,
        settleMs,
      );
      const credentials = await secrets.syncCredentials(
        paths,
        result.bindings,
        getCredentialManager(),
      );
      const changedSlugs = modelsChanged
        ? result.bindings.map((b: any) => b.slug)
        : credentials.updatedSlugs;
      for (const slug of changedSlugs)
        void deps.sessionManager.refreshConnectionRuntime(slug).catch(() => {
          deps.platform.logger?.warn('Odysseus: model runtime refresh deferred until next turn');
        });
      deps.sessionManager.refreshOdysseusSessions(result.updatedChats);
      status = {
        enabled: true,
        running: false,
        updatedAt: Date.now(),
        changedFiles: result.changes.length + sharedChanges,
        conflicts: [...result.conflicts, ...credentials.conflicts],
        deferred: result.deferred,
        unsupported: result.unsupported,
        language: preferences.uiLanguage,
        colorScheme: preferences.odysseusColorScheme,
      };
      return status;
    })()
      .catch(() => {
        // Raw provider errors and filesystem contents must never reach renderer diagnostics.
        status = { ...status, running: false, error: 'sync-failed' };
        return status;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  ipcMain.handle('odysseus:skill-prompt', async (event, name: unknown) => {
    trusted(event);
    if (!root || typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name))
      throw new Error('Invalid skill');
    const catalog = JSON.parse(await readFile(join(root, 'shared/skills-catalog.json'), 'utf8'));
    if (!catalog.entries.some((entry: { name: string }) => entry.name === name))
      throw new Error('Skill not found');
    return `Используй навык $${name}.\nЕсли навык не найден в текущем проекте, прочитай локальное руководство ${join(root, 'shared/skills', name, 'SKILL.md')} и применяй его в рамках моей задачи.\n\nСначала помоги уточнить мою задачу и необходимые исходные данные.`;
  });
  let knowledgeWorker: ChildProcess | undefined,
    knowledgeSequence = 0;
  const knowledgeRequests = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function knowledgeCommand(mode: string, options: unknown): Promise<any> {
    const node = process.env.ODYSSEUS_NODE;
    if (!root || !node) throw new Error('Restart Desktop using the Odysseus launcher');
    if (JSON.stringify(options || {}).length > 12000)
      throw new Error('Knowledge request too large');
    if (!knowledgeWorker?.connected) {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = fork(join(root, 'tools/knowledge-ui.mjs'), ['service'], {
        cwd: root,
        execPath: node,
        env,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      knowledgeWorker = child;
      child.on('message', (message: any) => {
        const request = knowledgeRequests.get(message?.id);
        if (!request) return;
        clearTimeout(request.timer);
        knowledgeRequests.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      });
      const fail = () => {
        if (knowledgeWorker !== child) return;
        knowledgeWorker = undefined;
        for (const r of knowledgeRequests.values()) {
          clearTimeout(r.timer);
          r.reject(new Error('Knowledge worker exited; retry'));
        }
        knowledgeRequests.clear();
      };
      child.once('error', fail);
      child.once('exit', fail);
    }
    const id = ++knowledgeSequence;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        knowledgeWorker?.kill();
        reject(new Error('Knowledge request timed out'));
      }, 45000);
      knowledgeRequests.set(id, { resolve: resolveRequest, reject, timer });
      knowledgeWorker!.send({ id, mode, options: options || {} }, (error) => {
        if (error) {
          clearTimeout(timer);
          knowledgeRequests.delete(id);
          reject(error);
        }
      });
    });
  }
  app.once('before-quit', () => knowledgeWorker?.kill());
  ipcMain.handle('odysseus:knowledge-view', async (event, options: unknown) => {
    trusted(event);
    return knowledgeCommand('snapshot', options);
  });
  ipcMain.handle('odysseus:knowledge-edit', async (event, operation: unknown) => {
    trusted(event);
    return knowledgeCommand('edit', operation);
  });
  ipcMain.handle('odysseus:knowledge-catalogs', async (event, options: unknown) => {
    trusted(event);
    return knowledgeCommand('catalogs', options);
  });
  ipcMain.handle('odysseus:knowledge-document', async (event, options: unknown) => {
    trusted(event);
    return knowledgeCommand('document', options);
  });
  let obsidianSync: Promise<any> | undefined;
  ipcMain.handle('odysseus:knowledge-obsidian-sync', async (event) => {
    trusted(event);
    if (obsidianSync) return obsidianSync;
    const node = process.env.ODYSSEUS_NODE;
    if (!root || !node) throw new Error('Odysseus launcher is required');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    obsidianSync = new Promise((resolveSync, reject) => {
      execFile(
        node,
        [join(root, 'tools/knowledge-obsidian-sync.mjs')],
        { cwd: root, env, timeout: 300000, maxBuffer: 2 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(stderr.trim() || 'Obsidian synchronization failed'));
            return;
          }
          try {
            resolveSync(JSON.parse(stdout));
          } catch {
            reject(new Error('Invalid Obsidian synchronization result'));
          }
        },
      );
    }).finally(() => {
      obsidianSync = undefined;
    });
    return obsidianSync;
  });
  const agentRequests = new Map<string, Promise<any>>();
  ipcMain.handle(
    'odysseus:knowledge-agent',
    async (event, options: { collection?: string } = {}) => {
      const workspaceId = trusted(event);
      if (!root) throw new Error('Odysseus launcher is required');
      const collection = options.collection || 'projects';
      if (!/^[a-z0-9-]{1,64}$/.test(collection)) throw new Error('Invalid knowledge catalog');
      const chatKey = workspaceId + ':' + collection;
      const existing = agentRequests.get(chatKey);
      if (existing) return existing;
      const request = (async () => {
        await ready;
        await deps.sessionManager.waitForInit();
        const file = join(paths.privateDir, 'knowledge-chats.json'),
          saved = store.document(file);
        let session = saved[chatKey]
          ? await deps.sessionManager.getSession(saved[chatKey], workspaceId)
          : null;
        if (!session) {
          const workspace = deps.workspaceService?.resolve(workspaceId);
          if (!workspace) throw new Error('Workspace unavailable');
          const source = await knowledgeCommand('agent-source', {
            collection,
            workspaceRoot: workspace.workspaceRootPath,
          });
          const slugs = [source.slug];
          session = await deps.sessionManager.createSession(workspaceId, {
            name: 'База знаний · ' + source.name,
            enabledSourceSlugs: slugs,
          });
          store.privateWrite(
            file,
            JSON.stringify({ ...saved, [chatKey]: session.id }, null, 2) + '\n',
          );
        }
        const prompt = `Работай как агент базы знаний каталога ${collection}. Не используй знания других каталогов без прямой просьбы. В каждый JSON-аргумент edit/snapshot передавай collection: ${collection}. Используй навык $graphify и подключённый MCP Graphify. Сначала прочитай ${join(root, 'docs/knowledge-obsidian-ru.md')}. Показывай источники связей, отличай гипотезы от фактов. Для функций используй graphify_project_path проекта как project_path MCP. Для ручных изменений используй Node.js ${join(root, 'tools/knowledge-ui.mjs')} edit с отдельным JSON-аргументом: add-note {label,description}, add-link {source,target,relation,evidence}, update-manual {id,label/description/relation}, remove-manual {id}. Сначала находи точные id через MCP или snapshot того же скрипта. Изменения сохраняются в overlay.json и подхватываются фоновым обновлением; graph.json напрямую не редактируй. Автоматические связи исправляй в исходных документах или коде. После изменения проверь snapshot и объясни результат. Выполняй задачу ниже:\n\n`;
        return { sessionId: session.id, prompt };
      })().finally(() => agentRequests.delete(chatKey));
      agentRequests.set(chatKey, request);
      return request;
    },
  );
  ipcMain.handle('odysseus:status', async (event) => {
    trusted(event);
    return status;
  });
  ipcMain.handle('odysseus:sync', async (event) => {
    trusted(event);
    return synchronize();
  });
  ipcMain.handle('odysseus:appearance', async (event, mode: unknown) => {
    trusted(event);
    if (!root || !['light', 'dark', 'system'].includes(String(mode))) return;
    await ready;
    // Synchronous read/replace preserves all unrelated native preferences.
    const path = join(paths.desktopHome, 'preferences.json'),
      prefs = store.document(path);
    store.privateWrite(
      path,
      JSON.stringify({ ...prefs, odysseusColorScheme: mode }, null, 2) + '\n',
    );
  });
  ipcMain.handle('odysseus:cli', async (event, sessionId: unknown) => {
    const workspaceId = trusted(event);
    if (!root) throw new Error('Odysseus launcher is required');
    if (
      sessionId !== undefined &&
      (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(sessionId))
    )
      throw new Error('Invalid session');
    const session =
      typeof sessionId === 'string'
        ? await deps.sessionManager.getSession(sessionId, workspaceId)
        : null;
    if (sessionId && !session) throw new Error('Session not found in this workspace');
    if (session?.isProcessing) throw new Error('Stop the current response before opening CLI');
    if (session)
      await deps.sessionManager.flushSession(session.id, workspaceId, {
        strict: true,
      });
    if (pending) await pending;
    const result = await synchronize(0);
    if (result.error && session?.messages?.length)
      throw new Error('Synchronization failed; retry using Synchronize');
    const state = store.document(join(paths.privateDir, 'state.json'));
    const pair = Object.values(state.chats || {}).find(
      (p: any) => p.workspaceId === workspaceId && p.desktopId === sessionId,
    ) as any;
    if (
      session?.messages?.length &&
      (!pair?.synced ||
        result.conflicts.some((c: string) => c.includes(pair.id)) ||
        result.deferred.some((c: string) => c.includes(pair.id)))
    ) {
      throw new Error(
        'This chat has pending changes or a conflict; synchronize it before opening CLI',
      );
    }
    const id = randomUUID(),
      request = join(paths.privateDir, 'launch', `${id}.json`);
    store.privateWrite(
      request,
      JSON.stringify({
        cwd: pair?.cwd || session?.workingDirectory || join(root, 'workspace'),
        cliId: pair?.cliId,
      }),
    );
    const node = process.env.ODYSSEUS_NODE;
    if (!node) throw new Error('Restart Desktop with the Odysseus launcher');
    await openOdysseusTerminal(root, node, request);
    return { opened: true };
  });
  if (root) {
    void synchronize();
    const timer = setInterval(() => {
      void synchronize();
    }, 5000);
    app.once('before-quit', () => {
      clearInterval(timer);
      worker?.kill('SIGTERM');
    });
  }
}
