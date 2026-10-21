import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { getValidCredentials, loadCredentials } from '../dp/dp-token-manager.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import type {
  AllowedStatistParameters,
  StatistEvent,
  OnStartupFinishedStatistEventParameters,
  // FeatureCallStatistEventParameters,
  AgentMessageStatistEventParameters,
  CounterStatistEventParameters,
  CompletionStatistEventParameters,
  ChatMessageStatistEventParameters,
  CompletionFailureReasonStatistEventParameters,
  AgentMessageAuthor,
  PluginInstallStatistEventParameters,
} from './statistEvents.js';
import {
  StatistEventName,
  CompletionStatus,
  // FeatureCallType,
  // FeatureCallStatus,
  AgentMessageStatus,
  ChatMessageStatus,
  CounterGroup,
} from './statistEvents.js';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { getErrorMessage, getErrorType } from '../utils/errors.js';
import { buildRuntimeFetchOptions } from '../utils/runtimeFetchOptions.js';

const logger = createDebugLogger('STATIST');

const PLUGIN_TYPE = 'nessy-cli';
const API_STATIST_EVENTS = 'https://api-statist.tinkoff.ru/gateway/v1/events';
const STATIST_SEND_INTERVAL = 20 * 1000; // ms
export const STATIST_AIDT_PROJECT = 'coretech.aidt.extension';
// [nessy-fork] statist-plugin-install — dedicated Marketplace-team project and
// plugin kind for the plugin.install event.
export const STATIST_MARKETPLACE_PROJECT = 'coretech.skills.marketplace';
export const MARKETPLACE_PLUGIN_KIND = 'nessy-extension';

// Глобальная переменная для хранения клиента Statist
let globalStatistClient: StatistClient | undefined;
let isStatistInitialized = false;

/**
 * Initialize the Statist client
 * @param config Application config
 */
export function initializeStatist(config: Config): void {
  if (isStatistInitialized) return;

  // Проверяем отдельную настройку для Statist телеметрии
  if (config.getTelemetryStatistEnabled()) {
    try {
      // Генерируем уникальный deviceId для устройства
      const deviceId = createDeviceId(config);

      // Создаем клиент Statist
      globalStatistClient = new StatistClient(
        STATIST_AIDT_PROJECT,
        deviceId,
        config.getProxy(),
      );

      // Запускаем клиент для периодической отправки событий
      globalStatistClient.run();

      logger.debug('Statist client initialized successfully');
    } catch (error) {
      logger.warn('Failed to initialize Statist client:', error);
      globalStatistClient = undefined;
    }
  }

  isStatistInitialized = true;
}

/**
 * Get the Statist client instance
 * @returns StatistClient instance or undefined if not initialized
 */
export function getStatistClient(): StatistClient | undefined {
  return globalStatistClient;
}

/**
 * Create a unique device ID or load existing one from user folder
 * @param config Application config
 * @returns Unique device ID
 */
function createDeviceId(config: Config): string {
  try {
    // Путь к файлу с deviceId в глобальной директории пользователя
    const deviceIdFilePath = path.join(
      Storage.getGlobalNessyDir(),
      'device_id',
    );

    // Проверяем существование файла с deviceId
    if (fs.existsSync(deviceIdFilePath)) {
      // Читаем существующий deviceId
      const deviceId = fs.readFileSync(deviceIdFilePath, 'utf8').trim();
      if (deviceId) {
        return deviceId;
      }
    }

    // Если файл не существует или пуст, генерируем новый deviceId
    const newDeviceId = crypto.randomUUID();

    // Создаем директорию если она не существует
    const globalNessyDir = Storage.getGlobalNessyDir();
    if (!fs.existsSync(globalNessyDir)) {
      fs.mkdirSync(globalNessyDir, { recursive: true });
    }

    // Сохраняем новый deviceId в файл
    fs.writeFileSync(deviceIdFilePath, newDeviceId, 'utf8');

    return newDeviceId;
  } catch (error) {
    logger.warn(
      'Failed to create or load device ID, falling back to session-based ID:',
      error,
    );
    // Fallback to original implementation if file operations fail
    const sessionId = config.getSessionId();
    const platform = process.platform;
    const arch = process.arch;
    return `${sessionId}-${platform}-${arch}`;
  }
}

/**
 * Update clientUploadTimestamp for events
 * @param events events for update
 * @returns events with actual clientUploadTimestamp
 */
const prepareEvents = (events: StatistEvent[]) =>
  events.map((event) => ({
    ...event,
    eventParameters: {
      ...event.eventParameters,
      clientUploadTimestamp: Date.now(),
    },
  }));

/**
 * Set correct plugin type to statist event parameters
 * @param params statist event parameters
 * @returns statist event parameters with correct plugin type
 */
function setCommonParameters(
  params: AllowedStatistParameters,
): AllowedStatistParameters {
  params.pluginType = PLUGIN_TYPE;
  return params;
}

/**
 * Get the user ID for Statist telemetry events.
 * Tries to get userId from DP auth credentials (even if current auth is different).
 * Falls back to 'unknown-user' if credentials are unavailable.
 */
export function getStatistUserId(): string {
  const creds = getValidCredentials() || loadCredentials();
  return creds?.username || creds?.userId || 'unknown-user';
}

export function getAgentLaunchMode(
  config: Config,
):
  | 'vscode'
  | 'acp'
  | 'sdk'
  | 'ci'
  | 'jetbrains'
  | 'nessycowork'
  | 'desktop'
  | 'tui'
  | 'nonInteractive' {
  switch (config.getChannel()?.trim().toUpperCase()) {
    case 'VSCODE':
      return 'vscode';
    case 'ACP':
      return 'acp';
    case 'SDK':
      return 'sdk';
    case 'CI':
      return 'ci';
    case 'JETBRAINS':
      return 'jetbrains';
    case 'NESSYCOWORK':
      return 'nessycowork';
    case 'DESKTOP':
      return 'desktop';
    default:
      return config.isInteractive() ? 'tui' : 'nonInteractive';
  }
}

export class StatistClient {
  private events: StatistEvent[] = [];
  private sequence = 1;
  // [nessy-fork] statist-trusted-ca
  private readonly fetchImpl: typeof fetch;
  private readonly fetchOptions: Record<string, unknown>;

  constructor(
    private project: string,
    private deviceId: string,
    proxyUrl?: string,
  ) {
    const runtimeOptions = buildRuntimeFetchOptions('openai', proxyUrl);
    this.fetchImpl = (runtimeOptions?.fetch ?? fetch) as typeof fetch;
    this.fetchOptions = runtimeOptions?.fetchOptions ?? {};
  }

  private sendEventToStatist = async (events: StatistEvent[]) => {
    if (events.length === 0) {
      return;
    }

    try {
      // Для nessy-cli мы будем использовать fetch API напрямую
      const response = await this.fetchImpl(API_STATIST_EVENTS, {
        ...this.fetchOptions,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(events),
      });

      if (!response.ok) {
        throw new Error(
          `Invalid status code: ${response.status} ${response.statusText}`,
        );
      }
      logger.debug(
        `Statist events sent successfully: count=${events.length}, status=${response.status} ${response.statusText}`,
      );
    } catch (e) {
      logger.error(
        `Statist request failed [${getErrorType(e)}]: ${getErrorMessage(e)}`,
      );
      // В nessy-cli нет Sentry, поэтому просто логируем ошибку
      return;
    }
  };

  run() {
    setInterval(() => {
      if (this.events.length === 0) {
        return;
      }

      // Copy and clear so we don't lose events that come while request is processing
      const eventsToSend = prepareEvents(this.events);
      this.events.length = 0;
      this.sendEventToStatist(eventsToSend);

      this.sequence += 1;
    }, STATIST_SEND_INTERVAL);
  }

  pushEvent = (
    name: StatistEventName,
    parameters: AllowedStatistParameters,
    options?: {
      // Override the event's project (defaults to this.project). Each event in
      // a batch carries its own project, so one client can target several.
      project?: string;
    },
  ) => {
    const body: StatistEvent = {
      project: options?.project ?? this.project,
      name: name,
      parameters: setCommonParameters(parameters),
      clientParameters: {
        client: 'nessy-cli',
        clientVersion: process.version,
        deviceId: this.deviceId,
        visitId: crypto.randomUUID(),
      },
      eventParameters: {
        clientEventTimestamp: Date.now(),
        clientUploadTimestamp: Date.now(),
        sequence: this.sequence,
        uuid: crypto.randomUUID(),
      },
    };
    this.events.push(body);
  };

  // Методы для отправки выбранных типов событий

  /**
   * Отправка события завершения запуска
   */
  sendStartupFinishedEvent(
    parameters: OnStartupFinishedStatistEventParameters,
  ) {
    this.pushEvent(StatistEventName.StartupFinished, parameters);
  }

  /**
   * Отправка события сообщения агента
   */
  sendAgentMessageEvent(parameters: AgentMessageStatistEventParameters) {
    this.pushEvent(StatistEventName.AgentMessage, parameters);
  }

  /**
   * Отправка счетчика
   */
  sendCounterEvent(parameters: CounterStatistEventParameters) {
    this.pushEvent(StatistEventName.Counter, parameters);
  }

  /**
   * Отправка события inline completion
   */
  sendInlineCompletionEvent(parameters: CompletionStatistEventParameters) {
    this.pushEvent(StatistEventName.InlineCompletionV2, parameters);
  }

  /**
   * Отправка события сообщения в чате
   */
  sendChatMessageEvent(parameters: ChatMessageStatistEventParameters) {
    this.pushEvent(StatistEventName.ChatMessage, parameters);
  }

  /**
   * Отправка причины ошибки завершения
   */
  sendCompletionFailureReasonEvent(
    parameters: CompletionFailureReasonStatistEventParameters,
  ) {
    this.pushEvent(StatistEventName.CompletionFailureReason, parameters);
  }

  /**
   * Отправка события установки extension в проект Marketplace.
   * Marketplace-параметры (packageName/installStatus/pluginKind) идут первыми,
   * чтобы соответствовать позиционным колонкам parameters_string_0/1/2.
   * Общие параметры (userId/pluginType) добавляются после них, как у всех
   * остальных событий.
   */
  sendPluginInstallEvent(parameters: PluginInstallStatistEventParameters) {
    this.pushEvent(StatistEventName.PluginInstall, parameters, {
      project: STATIST_MARKETPLACE_PROJECT,
    });
  }

  /**
   * Немедленно отправляет все накопленные события, не дожидаясь интервала.
   * Нужно для короткоживущих CLI-команд (например, `extensions install`),
   * которые завершаются через process.exit до срабатывания setInterval.
   */
  flush = async (): Promise<void> => {
    if (this.events.length === 0) {
      return;
    }
    const eventsToSend = prepareEvents(this.events);
    this.events.length = 0;
    this.sequence += 1;
    await this.sendEventToStatist(eventsToSend);
  };
}

export class StatisticsTracker {
  private lastSent = new Map<CompletionStatus, any>();

  constructor() {
    this.lastSent.set(CompletionStatus.Partially, {});
    this.lastSent.set(CompletionStatus.Showed, {});
  }

  setLastSent(status: CompletionStatus, item: any) {
    this.lastSent.set(status, item);
  }

  hasBeenSent(status: CompletionStatus, item: any): boolean {
    // Simplified implementation for nessy-cli
    return false;
  }
}

// Функции для отправки различных типов событий
// Эти функции будут аналогами функций записи метрик

/**
 * Send startup finished event
 */
export function recordStartupFinished(config: Config, userId: string): void {
  if (
    !globalStatistClient ||
    !isStatistInitialized ||
    !config.getTelemetryStatistEnabled()
  )
    return;

  globalStatistClient.sendStartupFinishedEvent({
    userId,
    configVersion: config.getCliVersion() || 'unknown',
  });
}

/**
 * Send agent message event
 */
export function recordAgentMessage(
  config: Config,
  userId: string,
  status: AgentMessageStatus,
  pluginVersion: string,
  abGroups: string[],
  lang: string,
  requestId: string,
  messageType: string,
  mode: string,
  chatId: string,
  author: AgentMessageAuthor,
  model?: string,
): void {
  if (
    !globalStatistClient ||
    !isStatistInitialized ||
    !config.getTelemetryStatistEnabled()
  )
    return;

  const resolvedModel = model ?? config.getModel();

  globalStatistClient.sendAgentMessageEvent({
    userId,
    status,
    pluginVersion,
    abGroups,
    pluginType: 'nessy-cli',
    lang,
    requestId,
    messageType,
    mode,
    chatId,
    author,
    launchMode: getAgentLaunchMode(config),
    authType: config.getAuthType(),
    model: resolvedModel,
  });
}

/**
 * Send counter event
 */
export function recordCounter(
  config: Config,
  userId: string,
  group: CounterGroup,
  name: string,
): void {
  if (
    !globalStatistClient ||
    !isStatistInitialized ||
    !config.getTelemetryStatistEnabled()
  )
    return;

  globalStatistClient.sendCounterEvent({
    userId,
    group,
    name,
  });
}

/**
 * Send inline completion event
 */
export function recordInlineCompletion(
  config: Config,
  userId: string,
  status: CompletionStatus,
  lang: string,
  requestId: string,
  abGroups: string[] = [],
): void {
  if (
    !globalStatistClient ||
    !isStatistInitialized ||
    !config.getTelemetryStatistEnabled()
  )
    return;

  globalStatistClient.sendInlineCompletionEvent({
    userId,
    status,
    lang,
    pluginVersion: config.getCliVersion() || 'unknown',
    abGroups,
    configVersion: config.getCliVersion() || 'unknown',
    requestId,
  });
}

/**
 * Send chat message event
 */
export function recordChatMessage(
  config: Config,
  userId: string,
  status: ChatMessageStatus,
  lang: string,
  requestId: string,
  abGroups: string[] = [],
): void {
  if (
    !globalStatistClient ||
    !isStatistInitialized ||
    !config.getTelemetryStatistEnabled()
  )
    return;

  globalStatistClient.sendChatMessageEvent({
    userId,
    status,
    lang,
    pluginVersion: config.getCliVersion() || 'unknown',
    abGroups,
    configVersion: config.getCliVersion() || 'unknown',
    requestId,
  });
}

/**
 * Send completion failure reason event
 */
export function recordCompletionFailureReason(
  config: Config,
  platform: string,
  reason: string,
  urlPath: string,
  statusCode?: string,
): void {
  if (
    !globalStatistClient ||
    !isStatistInitialized ||
    !config.getTelemetryStatistEnabled()
  )
    return;

  globalStatistClient.sendCompletionFailureReasonEvent({
    pluginVersion: config.getCliVersion() || 'unknown',
    platform,
    reason,
    urlPath,
    statusCode,
  });
}

/**
 * Send extension install event to the Marketplace Statist project.
 *
 * @param packageName npm package of the extension (install source)
 * @param installStatus 'success' or 'error'
 * @param pluginKind Marketplace plugin kind (defaults to 'nessy-extension')
 */
export function recordPluginInstall(
  config: Config,
  userId: string,
  packageName: string,
  installStatus: 'success' | 'error',
  pluginKind: string = MARKETPLACE_PLUGIN_KIND,
): void {
  if (
    !globalStatistClient ||
    !isStatistInitialized ||
    !config.getTelemetryStatistEnabled()
  )
    return;

  // Marketplace params first (map to parameters_string_0/1/2 in ClickHouse);
  // common params (userId, and pluginType via setCommonParameters) follow.
  globalStatistClient.sendPluginInstallEvent({
    packageName,
    installStatus,
    pluginKind,
    userId,
  });
}

/**
 * Flush any queued Statist events immediately.
 *
 * Short-lived CLI commands (e.g. `extensions install`) exit via process.exit
 * before the periodic send interval fires, which would drop queued events.
 * Call this (awaited) before such an exit. Safe no-op if Statist is disabled.
 */
export async function flushStatistEvents(): Promise<void> {
  if (!globalStatistClient || !isStatistInitialized) return;
  try {
    await globalStatistClient.flush();
  } catch {
    // Best-effort; never block shutdown on telemetry.
  }
}
