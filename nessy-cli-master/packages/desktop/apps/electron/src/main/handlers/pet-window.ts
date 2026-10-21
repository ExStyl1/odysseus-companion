import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import { RPC_CHANNELS } from '@craft-agent/shared/protocol';
import {
  ensureDefaultConversationWorkspace,
  getPetAcpSessions,
  getPetTerminalSessions,
} from '@craft-agent/shared/config';
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from './handler-deps';
import {
  TerminalSessionWatcher,
  resolveNessyDir,
  type TerminalSessionWatcherDeps,
} from '../session/terminal-session-watcher';
import { focusTerminalSession } from '../terminal-focus';

export const GUI_HANDLED_CHANNELS = [
  RPC_CHANNELS.window.PET_SET_ENABLED,
  RPC_CHANNELS.window.PET_SET_IGNORE_MOUSE,
  RPC_CHANNELS.window.PET_FOCUS_LAST_WINDOW,
  RPC_CHANNELS.window.PET_FOCUS_SESSION,
  // [nessy-fork] desktop-pet-session-aggregation
  RPC_CHANNELS.pet.ANSWER_TERMINAL_SESSION,
  RPC_CHANNELS.pet.FOCUS_TERMINAL_SESSION,
] as const;

/** Injectable seams so tests can substitute OS-touching collaborators
 * without module mocks (bun shares the module registry across test files,
 * so mock.module cannot rebind already-cached imports). */
export interface PetHandlerSeams {
  createWatcher?: PetWatcherFactory;
  focusTerminal?: typeof focusTerminalSession;
}

export type PetWatcherFactory = (
  nessyDir: string,
  deps: TerminalSessionWatcherDeps,
) => TerminalSessionWatcher;

const defaultPetWatcherFactory: PetWatcherFactory = (nessyDir, watcherDeps) =>
  new TerminalSessionWatcher(nessyDir, watcherDeps);

/**
 * GUI handlers for the floating desktop-pet window. The renderer that hosts the
 * main UI toggles the window on/off (and reloads it on pet change); the pet
 * window itself toggles click-through as the cursor enters/leaves the pet.
 */
export function registerPetWindowGuiHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  seams: PetHandlerSeams = {},
): void {
  server.handle(
    RPC_CHANNELS.window.PET_SET_ENABLED,
    (ctx, enabled: boolean) => {
      const wm = deps.windowManager;
      if (!wm) return;
      const workspaceId =
        ctx.webContentsId != null
          ? (wm.getWorkspaceForWindow(ctx.webContentsId) ?? '')
          : '';
      wm.setPetWindowEnabled(Boolean(enabled), workspaceId);
    },
  );

  server.handle(
    RPC_CHANNELS.window.PET_SET_IGNORE_MOUSE,
    (_ctx, ignore: boolean) => {
      deps.windowManager?.setPetWindowIgnoreMouse(Boolean(ignore));
    },
  );

  // [nessy-fork] desktop-pet-click-activation
  server.handle(RPC_CHANNELS.window.PET_FOCUS_LAST_WINDOW, () => {
    const wm = deps.windowManager;
    if (!wm) return;

    const window = wm.getLastActiveWindow();
    if (!window) {
      const workspace = ensureDefaultConversationWorkspace();
      wm.createWindow({ workspaceId: workspace.id });
      return;
    }

    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  // Clicking a pet notification card focuses the main window and navigates to
  // the originating session (reuses the OS-notification click path).
  server.handle(
    RPC_CHANNELS.window.PET_FOCUS_SESSION,
    async (ctx, sessionId: string) => {
      const wm = deps.windowManager;
      if (!wm || !sessionId || ctx.webContentsId == null) return;
      const workspaceId = wm.getWorkspaceForWindow(ctx.webContentsId);
      if (!workspaceId) return;
      const { handleNotificationClick } = await import('../notifications');
      handleNotificationClick(workspaceId, sessionId);
    },
  );

  registerExternalSessionWatcher(server, deps, seams.createWatcher);

  // [nessy-fork] desktop-pet-session-aggregation: append an MR2
  // confirmation_response to a terminal session's input.jsonl. The path
  // arrives from the renderer (ultimately from runtime.json) — untrusted —
  // so it is validated against the CLI's own ctl layout BEFORE any write.
  server.handle(
    RPC_CHANNELS.pet.ANSWER_TERMINAL_SESSION,
    async (
      _ctx,
      payload: {
        controlInputFile?: string;
        requestId?: string;
        optionId?: string;
        allow?: boolean;
        cancel?: boolean;
      },
    ): Promise<{ ok: boolean; error?: string }> => {
      if (
        !payload?.controlInputFile ||
        !payload.requestId ||
        (!payload.optionId && !payload.cancel && !payload.allow)
      ) {
        return { ok: false, error: 'controlInputFile, requestId and optionId (or allow/cancel) are required' };
      }
      const validated = validateControlInputPath(payload.controlInputFile);
      if (!validated) {
        return { ok: false, error: 'controlInputFile must be ~/.nessy/ctl/<sessionId>/input.jsonl' };
      }
      const hardened = await resolveWithoutSymlinks(validated);
      if (!hardened) {
        return { ok: false, error: 'controlInputFile resolves outside the ctl directory' };
      }
      // Cancel/allow without an explicit option use the MR2 legacy binary
      // form; an option answer carries its option_id.
      const line = payload.optionId
        ? { type: 'confirmation_response', request_id: payload.requestId, option_id: payload.optionId }
        : { type: 'confirmation_response', request_id: payload.requestId, allowed: !payload.cancel };
      try {
        await fs.appendFile(hardened, JSON.stringify(line) + '\n', 'utf-8');
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  // Focus the terminal owning an external session (AppleScript on macOS).
  const focusTerminal = seams.focusTerminal ?? focusTerminalSession;
  server.handle(
    RPC_CHANNELS.pet.FOCUS_TERMINAL_SESSION,
    async (_ctx, payload: { pid?: number; workDir?: string }) => {
      await focusTerminal(payload ?? {});
    },
  );
}

/**
 * The ctl input channel always lives under `$HOME/.nessy/ctl` — the CLI's
 * session-control-paths use os.homedir() directly (NESSY_HOME does NOT
 * affect them), so the validation root must match exactly that.
 */
const CTL_SAFE_ID = /^[A-Za-z0-9._-]+$/;

function validateControlInputPath(input: string): string | null {
  const resolved = path.resolve(input);
  const ctlRoot = path.resolve(path.join(os.homedir(), '.nessy', 'ctl'));
  const dir = path.dirname(resolved);
  const sessionId = path.basename(dir);
  if (
    path.basename(resolved) !== 'input.jsonl' ||
    path.dirname(dir) !== ctlRoot ||
    !CTL_SAFE_ID.test(sessionId)
  ) {
    return null;
  }
  return resolved;
}

/**
 * Symlink hardening: path.resolve does not follow symlinks, so a symlinked
 * session dir (or input.jsonl itself) could redirect the append outside the
 * ctl tree. Resolve the real paths and require both the directory and, when
 * the file already exists, the file itself to stay under the real ctl root.
 * The file not existing yet is fine — appendFile creates it in the (already
 * verified) real directory.
 */
async function resolveWithoutSymlinks(validated: string): Promise<string | null> {
  const realCtlRoot = await fs
    .realpath(path.join(os.homedir(), '.nessy', 'ctl'))
    .catch(() => null);
  if (!realCtlRoot) return null;
  const realDir = await fs
    .realpath(path.dirname(validated))
    .catch(() => null);
  if (!realDir || !realDir.startsWith(realCtlRoot + path.sep)) return null;
  const realFile = await fs.realpath(validated).catch(() => null);
  if (realFile && !realFile.startsWith(realCtlRoot + path.sep)) return null;
  return validated;
}

// Module-level: one live watcher at a time. Re-registration (tests re-run
// registerGuiRpcHandlers in the same bun process) stops the previous one —
// a stale watcher would keep pushing to a dead RpcServer.
let externalSessionWatcher: TerminalSessionWatcher | null = null;

function registerExternalSessionWatcher(
  server: RpcServer,
  deps: HandlerDeps,
  createWatcher: PetWatcherFactory | undefined,
): void {
  const factory = createWatcher ?? defaultPetWatcherFactory;
  externalSessionWatcher?.stop();
  externalSessionWatcher = factory(resolveNessyDir(), {
    emit: (update) => {
      pushTyped(server, RPC_CHANNELS.pet.SESSION_UPDATE, { to: 'all' }, update);
    },
    // Desktop in-app agents run their own `nessy --acp` child whose sidecar
    // would double-report alongside session:event — skip those sessions.
    getDesktopSessionIds: () =>
      new Set(
        deps.sessionManager
          .getActiveSessionsInfo()
          .map((info) => info.sessionId),
      ),
    // Source gates from stored config — read every cycle so the settings
    // toggles apply within one poll interval, no watcher restart needed.
    getTerminalSessionsEnabled: () => getPetTerminalSessions(),
    getAcpSessionsEnabled: () => getPetAcpSessions(),
  });
  externalSessionWatcher.start();
  // Optional chaining: test files mock `electron` with varying fidelity, and
  // in bun's shared module registry pet-window may be bound to whichever
  // mock was registered first — real Electron always has app.once.
  app.once?.('will-quit', () => {
    externalSessionWatcher?.stop();
    externalSessionWatcher = null;
  });
}
