/**
 * Quick notification cards shown above the desktop pet — one card per session,
 * updated in place as that session's state changes (running -> permission ->
 * complete / error).
 *
 * Two feeds converge here:
 * - `session:event` for desktop in-app sessions (permission_request cards get
 *   inline answer buttons);
 * - `pet:sessionUpdate` for external CLI sessions (terminal TUI / ACP) with
 *   phase snapshots and MR2 input.jsonl answers.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  PetSessionUpdate,
  SessionEvent,
} from '@craft-agent/shared/protocol';
import {
  mapPhaseToPetNotification,
  canReplaceCardKind,
  permissionRequestToNotification,
  terminalAnswerStyle,
  type PermissionAnswerStyle,
} from './pet-session-mapping';

export type PetNotificationKind =
  | 'running'
  | 'permission'
  | 'success'
  | 'error'
  | 'info';

export interface PetNotification {
  sessionId: string;
  kind: PetNotificationKind;
  /** i18n key for the card title. */
  titleKey: string;
  /** monotonic update counter — newest on top. */
  seq: number;
  /** Project basename for external sessions (card subtitle). */
  title?: string;
  /** Where the session lives — picks the answer/focus path. */
  source?: 'desktop' | 'terminal' | 'acp';
  /** Present for kind === 'permission': inline answer data. */
  requestId?: string;
  options?: PetSessionUpdate['options'];
  /** respondToPermission/respondToElicitation answers key — question index as string ('0'). */
  answerKey?: string;
  /** Question arrived as ACP elicitation — answer via respondToElicitation. */
  elicitation?: boolean;
  /** How the card can be answered inline (computed by the mapping module). */
  answerStyle?: PermissionAnswerStyle;
  toolName?: string;
  summary?: string;
  controlInputFile?: string;
  workDir?: string;
  pid?: number;
}

// Streaming/working signals that keep a session in the "running" state.
const ACTIVITY = new Set([
  'text_delta',
  'text_complete',
  'tool_result',
  'status',
  'task_progress',
]);

let seq = 0;

export function usePetNotifications() {
  const [bySession, setBySession] = useState<Map<string, PetNotification>>(
    () => new Map(),
  );

  const dismiss = useCallback((sessionId: string) => {
    setBySession((prev) => {
      if (!prev.has(sessionId)) return prev;
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  const clear = useCallback(() => setBySession(new Map()), []);

  useEffect(() => {
    const setState = (card: Omit<PetNotification, 'seq'>) => {
      setBySession((prev) => {
        const cur = prev.get(card.sessionId);
        // Same kind + same pending request ⇒ no transition, no churn. A new
        // requestId (follow-up question) must re-render for new buttons.
        if (cur && cur.kind === card.kind && cur.requestId === card.requestId) {
          return prev;
        }
        // A pending DESKTOP question survives activity churn — events trail
        // the question push out of order and cannot be trusted as "answered";
        // external cards are replaced by their own phase pushes.
        if (cur && !canReplaceCardKind(cur, card.kind)) {
          return prev;
        }
        seq += 1;
        const next = new Map(prev);
        next.set(card.sessionId, { ...card, seq });
        return next;
      });
    };

    const dropSession = (sessionId: string) => {
      setBySession((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
    };

    /** The question was answered (chat or pet card) — drop the matching card. */
    const dropResolved = (sessionId: string, requestId: string) => {
      setBySession((prev) => {
        const cur = prev.get(sessionId);
        if (cur?.kind !== 'permission' || cur.requestId !== requestId) {
          return prev;
        }
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
    };

    const cleanupSessionEvents = window.electronAPI?.onSessionEvent?.(
      (event: SessionEvent) => {
        // A malformed event must never kill this subscription — the pet
        // would go silent for every later session (observed live).
        try {
        const sessionId = (event as { sessionId?: string }).sessionId;
        if (!sessionId) return;
        switch (event.type) {
          // [nessy-fork] desktop-pet-session-aggregation × acp-elicitation:
          // ask_user_question arrives as a permission_request OR as an ACP
          // elicitation form (AIDT-8203) — same questions shape, answered via
          // respondToPermission / respondToElicitation respectively.
          case 'permission_request':
          case 'elicitation_request': {
            const isElicitation = event.type === 'elicitation_request';
            const req = isElicitation
              ? {
                  requestId: event.request.requestId,
                  description: event.request.description,
                  questions: event.request.questions,
                  elicitation: true,
                }
              : event.request;
            const card = permissionRequestToNotification(req);
            setState({
              sessionId,
              kind: 'permission',
              titleKey: 'pet.notify.approval',
              source: 'desktop',
              requestId: card.requestId,
              answerKey: card.answerKey,
              elicitation: isElicitation,
              summary: card.summary,
              options: card.options,
              answerStyle: card.answerStyle,
              toolName: card.toolName,
            });
            break;
          }
          // [nessy-fork] desktop-pet-session-aggregation: answered in the chat
          // (or by our own button) — the pet card must not linger until the
          // turn ends.
          case 'elicitation_resolved':
          case 'permission_resolved':
            dropResolved(
              sessionId,
              (event as { requestId?: string }).requestId ?? '',
            );
            break;
          case 'complete':
            setState({
              sessionId,
              kind: 'success',
              titleKey: 'pet.notify.complete',
            });
            break;
          case 'error':
            setState({ sessionId, kind: 'error', titleKey: 'pet.notify.error' });
            break;
          case 'interrupted':
            setState({
              sessionId,
              kind: 'info',
              titleKey: 'pet.notify.interrupted',
            });
            break;
          default:
            if (ACTIVITY.has(event.type)) {
              setState({
                sessionId,
                kind: 'running',
                titleKey: 'pet.notify.running',
              });
            }
            break;
        }
        } catch (err) {
          console.error('[pet] session event handling failed:', err);
        }
      },
    );

    // External CLI sessions (terminal/ACP). `gone`/`idle` drop the card; the
    // watcher already dedups pushes, so identical snapshots don't churn.
    const cleanupPetUpdates = window.electronAPI?.onPetSessionUpdate?.(
      (update: PetSessionUpdate) => {
        if (update.phase === 'gone' || update.phase === 'idle') {
          dropSession(update.sessionId);
          return;
        }
        const card = mapPhaseToPetNotification(update.phase);
        if (!card) return;
        setState({
          sessionId: update.sessionId,
          kind: card.kind,
          titleKey: card.titleKey,
          title: update.title,
          source: update.source,
          requestId: update.requestId,
          summary: update.summary,
          options: update.options,
          controlInputFile: update.controlInputFile,
          workDir: update.workDir,
          pid: update.pid,
          // waiting_input without options falls back to Allow / Cancel.
          answerStyle:
            card.kind === 'permission' ? terminalAnswerStyle(update) : undefined,
        });
      },
    );

    return () => {
      cleanupSessionEvents?.();
      cleanupPetUpdates?.();
    };
  }, []);

  /**
   * Answer a permission card inline. Terminal sessions append an MR2
   * confirmation_response; desktop sessions reuse respondToPermission;
   * ACP cards are display-only. The card is dropped optimistically — the
   * next phase push / permission response rebuilds state.
   */
  const answer = useCallback(
    async (
      n: PetNotification,
      option?: { optionId?: string; cancel?: boolean },
    ) => {
      if (!n.requestId) return;
      const cancel = option?.cancel === true;

      if (n.source === 'terminal') {
        if (!n.controlInputFile) return;
        try {
          const res = await window.electronAPI?.answerTerminalSession?.({
            controlInputFile: n.controlInputFile,
            requestId: n.requestId,
            optionId: cancel ? undefined : option?.optionId,
            // Option-less approval (allow_deny card): the MR2 legacy binary
            // form — the handler writes {"allowed":true}.
            allow: !cancel && !option?.optionId,
            cancel,
          });
          // Dismiss only when the write landed; a rejected/failed write keeps
          // the card so the user can retry.
          if (!res || res.ok !== false) dismiss(n.sessionId);
        } catch (err) {
          console.error('[pet] answerTerminalSession failed:', err);
        }
        return;
      }

      if (n.source === 'desktop') {
        // The agent and the chat UI key answers by question INDEX
        // (AskUserQuestionRequest / resolveAskUserQuestionOptionId), not by
        // header — a header-keyed answer is silently treated as unanswered.
        try {
          if (n.elicitation) {
            const ok = await window.electronAPI?.respondToElicitation?.(
              n.sessionId,
              n.requestId,
              cancel
                ? { action: 'cancel' }
                : option?.optionId && n.answerKey
                  ? { action: 'accept', content: { [n.answerKey]: option.optionId } }
                  : { action: 'decline' },
            );
            if (ok !== false) dismiss(n.sessionId);
          } else {
            const answers =
              !cancel && option?.optionId && n.answerKey
                ? { answers: { [n.answerKey]: option.optionId } }
                : undefined;
            const ok = await window.electronAPI?.respondToPermission?.(
              n.sessionId,
              n.requestId,
              !cancel,
              false,
              answers,
            );
            if (ok !== false) dismiss(n.sessionId);
          }
        } catch (err) {
          console.error('[pet] respond failed:', err);
        }
      }
      // acp — display-only until the CLI's ACP mode grows an input channel.
    },
    [dismiss],
  );

  const items = useMemo(
    () => Array.from(bySession.values()).sort((a, b) => b.seq - a.seq),
    [bySession],
  );

  return { items, dismiss, clear, answer };
}
