import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthType } from '../../core/contentGenerator.js';
import type { Config } from '../../config/config.js';
import { promptIdContext } from '../../utils/promptIdContext.js';

/**
 * Контекст для DLH телеметрии.
 * Хранит текущий sessionId, promptId, turn counter, authType и config для автоматической подстановки в события.
 */
export interface DlhContext {
  sessionId: string;
  promptId: string | null;
  parentPromptId: string | null;
  parentToolCallId: string | null;
  turn: number;
  authType: AuthType | null;
  config: Config | null;
  inferenceId: string | null;
}

export type DlhContextSnapshot = Readonly<DlhContext>;

export type DlhContextOverrides = Partial<
  Pick<
    DlhContext,
    | 'sessionId'
    | 'promptId'
    | 'parentPromptId'
    | 'parentToolCallId'
    | 'turn'
    | 'authType'
    | 'config'
    | 'inferenceId'
  >
>;

/**
 * AsyncLocalStorage для DLH контекста.
 * Позволяет автоматически передавать контекст через асинхронные вызовы без явной передачи параметров.
 */
export const dlhContextStorage = new AsyncLocalStorage<DlhContext>();

/**
 * Выполняет callback в контексте DLH сессии.
 * Все вызовы recordDlhEvent внутри callback автоматически получат sessionId и promptId из контекста.
 *
 * @param context - DLH контекст с sessionId, promptId и turn
 * @param callback - Функция для выполнения в контексте
 * @returns Результат выполнения callback
 */
export function runInDlhContext<T>(context: DlhContext, callback: () => T): T {
  return dlhContextStorage.run(context, callback);
}

export function runWithDlhCorrelation<T>(
  context: DlhContextSnapshot,
  callback: () => T,
): T {
  return dlhContextStorage.run({ ...context }, callback);
}

/**
 * Получает текущий DLH контекст.
 * Возвращает null, если вызов происходит вне контекста.
 *
 * @returns Текущий DLH контекст или null
 */
export function getCurrentDlhContext(): DlhContext | null {
  return dlhContextStorage.getStore() ?? null;
}

export function getDlhConfig(config?: Config | null): Config | undefined {
  return config ?? getCurrentDlhContext()?.config ?? undefined;
}

export function getDlhSessionId(config?: Config | null): string {
  const configSessionId =
    typeof config?.getSessionId === 'function'
      ? config.getSessionId()
      : undefined;
  return getCurrentDlhContext()?.sessionId ?? configSessionId ?? 'unknown';
}

export function getDlhParentPromptId(
  parentPromptId?: string | null,
): string | null {
  return parentPromptId ?? getCurrentDlhContext()?.parentPromptId ?? null;
}

export function getDlhParentToolCallId(
  parentToolCallId?: string | null,
): string | null {
  return parentToolCallId ?? getCurrentDlhContext()?.parentToolCallId ?? null;
}

export function getDlhPromptId(promptId?: string | null): string {
  return (
    promptId ??
    getCurrentDlhContext()?.promptId ??
    promptIdContext.getStore() ??
    'unknown'
  );
}

export function getDlhOptionalPromptId(
  promptId?: string | null,
): string | null {
  return (
    promptId ??
    getCurrentDlhContext()?.promptId ??
    promptIdContext.getStore() ??
    null
  );
}

/**
 * Обновляет turn counter в текущем DLH контексте.
 * Используется при каждом новом пользовательском сообщении.
 *
 * @returns Новый номер turn или null, если контекст не установлен
 */
export function incrementDlhTurn(): number | null {
  const context = getCurrentDlhContext();
  if (!context) return null;

  context.turn += 1;
  return context.turn;
}

/**
 * Устанавливает turn counter в текущем DLH контексте.
 * Используется для синхронизации с внешним счётчиком turn'ов.
 *
 * @param turn - Номер turn для установки
 * @returns true если контекст обновлён, false если контекст не установлен
 */
export function updateDlhTurn(turn: number): boolean {
  const context = getCurrentDlhContext();
  if (!context) return false;

  context.turn = turn;
  return true;
}

/**
 * Устанавливает promptId в текущем DLH контексте.
 * Используется при каждом новом пользовательском запросе.
 *
 * @param promptId - ID промпта для установки
 * @returns true если контекст обновлён, false если контекст не установлен
 */
export function setDlhPromptId(promptId: string): boolean {
  const context = getCurrentDlhContext();
  if (!context) return false;

  context.promptId = promptId;
  return true;
}

export function captureDlhCorrelation(
  overrides: DlhContextOverrides = {},
): DlhContextSnapshot {
  const current = getCurrentDlhContext();
  const config = overrides.config ?? current?.config ?? null;
  return {
    sessionId:
      overrides.sessionId ??
      current?.sessionId ??
      config?.getSessionId() ??
      'unknown',
    promptId:
      overrides.promptId ??
      current?.promptId ??
      promptIdContext.getStore() ??
      null,
    parentPromptId: overrides.parentPromptId ?? current?.parentPromptId ?? null,
    parentToolCallId:
      overrides.parentToolCallId ?? current?.parentToolCallId ?? null,
    turn: overrides.turn ?? current?.turn ?? 0,
    authType: overrides.authType ?? current?.authType ?? null,
    config,
    inferenceId: overrides.inferenceId ?? current?.inferenceId ?? null,
  };
}

/**
 * Создаёт новый DLH контекст для сессии.
 *
 * @param sessionId - ID сессии
 * @param initialTurn - Начальный номер turn (по умолчанию 0)
 * @param authType - Тип аутентификации (по умолчанию null)
 * @returns Новый DLH контекст
 */
export function createDlhContext(
  sessionId: string,
  initialTurn: number = 0,
  authType: AuthType | null = null,
  config: Config | null = null,
): DlhContext {
  return {
    sessionId,
    promptId: null,
    parentPromptId: null,
    parentToolCallId: null,
    turn: initialTurn,
    authType,
    config,
    inferenceId: null,
  };
}

/**
 * Создаёт новый DLH контекст и возвращает его.
 * Используется для инициализации контекста в начале запроса.
 *
 * @param sessionId - ID сессии
 * @param promptId - ID промпта
 * @param turn - Номер turn (по умолчанию 0)
 * @param authType - Тип аутентификации (по умолчанию null)
 * @returns Новый DLH контекст
 */
export function initializeDlhContext(
  sessionId: string,
  promptId: string,
  turn: number = 0,
  authType: AuthType | null = null,
  config: Config | null = null,
): DlhContext {
  const context: DlhContext = {
    sessionId,
    promptId,
    parentPromptId: null,
    parentToolCallId: null,
    turn,
    authType,
    config,
    inferenceId: null,
  };
  dlhContextStorage.enterWith(context);
  return context;
}
