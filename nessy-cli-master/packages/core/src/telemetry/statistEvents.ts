export enum StatistEventName {
  Auth = 'events.auth',
  StartupFinished = 'events.startupFinished',
  // FeatureCall = 'events.featureCall',
  Counter = 'events.counter',
  InlineCompletionV2 = 'events.inlineCompletionV2',
  // BlockCompletion = 'events.blockCompletion',
  ChatMessage = 'events.chatMessage',
  AgentMessage = 'events.agentMessage',
  AuthState = 'events.authState',
  CompletionFailureReason = 'events.completionFailureReason',
  // [nessy-fork] statist-plugin-install — Marketplace team event: extension
  // install result. Sent to a dedicated Statist project (see
  // STATIST_MARKETPLACE_PROJECT in statistClient.ts).
  PluginInstall = 'plugin.install',
}

export enum StatistAuthResult {
  Enabled = 'enabled',
  InitCheckFileFailed = 'init_check_file_failed',
  InitCheckFolderFailed = 'init_check_folder_failed',
  InitCompleted = 'init_completed',
  InitCreateFolderFailed = 'init_create_folder_failed',
  InitDownloadFailed = 'init_download_failed',
  InitDPLoginSucceeded = 'init_dp_login_succeeded',
  InitDPLoginFailed = 'init_dp_login_failed',
  InitFailed = 'init_failed',
  InitMakePermissionFailed = 'init_make_permission_failed',
  LoginFailed = 'login_failed',
  LoginSuccess = 'login_success',
  LogoutSuccess = 'logout_success',
  NeedLogin = 'need_login',
  TokenReceivedSuccessfully = 'token_received_successfully',
  TokenReceiveFailed = 'token_receive_failed',
  TokenRetrievedFromCache = 'token_retrieved_from_cache',
  TokenUsageForbidden = 'token_usage_forbidden',
  TokenUsageUnauthorized = 'token_usage_unauthorized',
}

export enum FeatureCallStatus {
  Started = 'started',
  Completed = 'completed',
  Failed = 'failed',
  Canceled = 'canceled',
}

export enum CompletionStatus {
  // Completion fully accepted by user in one tap
  Accepted = 'accepted',
  // Completion is requested from a remote model
  Requested = 'requested',
  // User accepted completion but only partially. He used shortcut to accept some tokens.
  // If he accepted multiple tokens, metrics should be send only once per completion.
  Partially = 'partially',
  // Completion is showed to a user. It must be sent for each time user sees completion after any document change.
  // We assume that a single partially accepted completion is still the same completion, so we shouldn't send this event again.
  Showed = 'showed',
  // Completion request failed
  Failed = 'failed',
  // Completion received from backend
  Received = 'received',
}

export enum AgentMessageStatus {
  // Message is requested from a remote model
  Requested = 'requested',
  // Message part successfully processed
  Succeeded = 'succeeded',
  // User aborted task performing
  Aborted = 'aborted',
  // Message part performance failed
  Failed = 'failed',
}

export enum ChatMessageStatus {
  // Message is requested from a remote model
  Requested = 'requested',
  // Message is showed to a user
  Showed = 'showed',
  // Message request failed
  Failed = 'failed',
  // Message received from backend
  Received = 'received',
}

export enum StatistAuthState {
  Authorized = 'authorized',
  NeedLogin = 'need_login',
}

export type AgentMessageAuthor = 'user' | 'assistant';

export enum FeatureCallType {
  CreateBranch = 'createBranch',
  CreateSnippet = 'createSnippet',
  WrapSecret = 'wrapSecret',
  ClickOnApproversLink = 'clickOnApproversLink',
  CopyCodeBlockInChat = 'copyCodeBlockInChat',
  CommitMessage = 'commitMessage',
  UnitTestsGeneration = 'unitTestsGeneration',
}

export enum CounterGroup {
  ComplianceCI = 'complianceCI',
  CommitMessage = 'commitMessage',
  UseVSCodeNavigation = 'useVSCodeNavigation',
  Chat = 'chatV2',
  TestsGen = 'testsGeneration',
  MuteCompletions = 'muteCompletions',
  ResetCompletionsSettings = 'resetCompletionsSettings',
  EditCode = 'editCode',
  CodeActions = 'codeActions',
  ContextPrompter = 'contextPrompter',
  IDELanguage = 'IDELanguage',
  IDETheme = 'IDETheme',
  StopTrackingTrueCompletion = 'StopTrackingTrueCompletion',
  TenantExplorer = 'tenantExplorer',
}

export type AuthStatistEventParameters = {
  platform: string;
  pluginVersion: string;
  result: StatistAuthResult;
  pluginType?: string;
};

export type OnStartupFinishedStatistEventParameters = {
  userId: string;
  configVersion: string;
  pluginType?: string;
};

export type FeatureCallStatistEventParameters = {
  userId: string;
  type: FeatureCallType;
  status: FeatureCallStatus;
  configVersion: string;
  pluginType?: string;
};

export type CounterStatistEventParameters = {
  userId: string;
  pluginType?: string;
  group: CounterGroup;
  name: string;
};

export type CompletionStatistEventParameters = {
  userId: string;
  status: CompletionStatus;
  lang: string;
  pluginVersion: string;
  abGroups: string[];
  configVersion: string;
  requestId: string;
  pluginType?: string;
};

export type ChatMessageStatistEventParameters = {
  userId: string;
  status: ChatMessageStatus;
  lang: string;
  pluginVersion: string;
  abGroups: string[];
  configVersion: string;
  requestId: string;
  pluginType?: string;
};

/**
 * Parameters for agent message statistics events.
 * Used to track agent message processing and performance metrics.
 */
export type AgentMessageStatistEventParameters = {
  /** User identifier for telemetry tracking */
  userId: string;

  /** Version of the plugin sending the event */
  pluginVersion: string;

  /** A/B testing groups the user belongs to */
  abGroups: string[];

  /**
   * Type of plugin (automatically set by StatistClient)
   * @see StatistClient
   */
  pluginType?: string;

  /** Author of the message (User or Assistant) */
  author: AgentMessageAuthor;

  /** Current status of the agent message processing */
  status: AgentMessageStatus;

  /**
   * Programming language context for the message
   * Uses short language codes from VS Code language identifiers
   * @see {@link https://code.visualstudio.com/docs/languages/identifiers}
   */
  lang: string;

  /** Unique identifier for the request */
  requestId: string;

  /** Type of message being processed */
  messageType: string;

  /** Work mode of the agent when processing the message */
  mode: string;

  /**
   * Identifier for the task(chat) session
   * Note: This field represents a chatId but in cline is named taskId
   */
  chatId: string;

  /** Agent launch mode used for the current message */
  launchMode?:
    | 'vscode'
    | 'acp'
    | 'sdk'
    | 'ci'
    | 'jetbrains'
    | 'nessycowork'
    | 'desktop'
    | 'tui'
    | 'nonInteractive';

  /** Authentication type used for the current session or request */
  authType?: string;

  /** Model identifier used to process the current agent message */
  model?: string;
};

export type AuthStateStatistEventParameters = {
  userId: string;
  pluginType: string;
  status: StatistAuthState;
  pluginVersion: string;
  platform: string;
};

/**
 * Parameters for the Marketplace "plugin.install" Statist event.
 *
 * The Marketplace ClickHouse schema maps the marketplace-specific string
 * parameters positionally, so they MUST stay first and in this order:
 *   packageName   -> parameters_string_0
 *   installStatus -> parameters_string_1
 *   pluginKind    -> parameters_string_2
 *
 * Common parameters (userId, pluginType — the latter injected by
 * setCommonParameters) are appended after them, like on every other event.
 */
export type PluginInstallStatistEventParameters = {
  /** npm package of the extension, e.g. @ai-office/nessy-extension-... */
  packageName: string;
  /** Install result */
  installStatus: 'success' | 'error';
  /** Marketplace plugin kind. Currently always 'nessy-extension'. */
  pluginKind: string;
  /** User identifier for telemetry tracking (common parameter) */
  userId: string;
  /** Plugin type (common parameter, set by StatistClient) */
  pluginType?: string;
};

export type CompletionFailureReasonStatistEventParameters = {
  pluginType?: string;
  pluginVersion: string;
  platform: string;
  reason: string;
  urlPath: string;
  statusCode?: string;
};

// Union type for all allowed statist parameters
export type AllowedStatistParameters =
  // for StatistEvent.name == StatistEventName.Auth
  | AuthStatistEventParameters
  // for StatistEvent.name == StatistEventName.StartupFinished
  | OnStartupFinishedStatistEventParameters
  // for StatistEvent.name == StatistEventName.FeatureCall
  | FeatureCallStatistEventParameters
  // for StatistEvent.name == StatistEventName.Counter
  | CounterStatistEventParameters
  // for StatistEvent.name == StatistEventName.InlineCompletionV2
  | CompletionStatistEventParameters
  // for StatistEvent.name == StatistEventName.ChatMessage
  | ChatMessageStatistEventParameters
  // for StatistEvent.name == StatistEventName.AgentMessage
  | AgentMessageStatistEventParameters
  // for StatistEvent.name == StatistEventName.CompletionFailureReason
  | CompletionFailureReasonStatistEventParameters
  // for StatistEvent.name == StatistEventName.AuthState
  | AuthStateStatistEventParameters
  // for StatistEvent.name == StatistEventName.PluginInstall
  | PluginInstallStatistEventParameters;

export type StatistEvent = {
  project: string;
  name: StatistEventName;
  parameters: AllowedStatistParameters;
  clientParameters: {
    client: string;
    clientVersion: string;
    deviceId: string;
    visitId: string;
    deviceModel?: string;
  };
  eventParameters: {
    clientEventTimestamp: number;
    clientUploadTimestamp: undefined | number;
    sequence: number;
    uuid: string;
  };
};
