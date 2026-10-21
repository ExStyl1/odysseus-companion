export const DEFAULT_TIMEOUT = 120000;
export const DEFAULT_MAX_RETRIES = 3;

export const LLM_PROXY_BASE_URL = 'https://llm-proxy.t-tech.team/v1';
export const DEFAULT_OPENAI_BASE_URL = LLM_PROXY_BASE_URL;
export const DEFAULT_DASHSCOPE_BASE_URL = '--api';
export const DEFAULT_DEEPSEEK_BASE_URL = '--api';
export const DEFAULT_OPEN_ROUTER_BASE_URL = '--api';
export const DASHSCOPE_PROXY_BASE_URL = process.env['DASHSCOPE_PROXY_BASE_URL'];

export const NESTOR_SERVER_URL = 'https://code-completion-nestor.tcsbank.ru';
export const DEFAULT_NESTOR_BASE_URL = `${NESTOR_SERVER_URL}/api/v1/cli/openai-like/v1`;
// [nessy-fork] dp-auth-anthropic-generator
export const DEFAULT_NESTOR_ANTHROPIC_BASE_URL = `${NESTOR_SERVER_URL}/api/v1/cli/anthropic`;
// [nessy-fork] dp-byok-error-handling
export const DEFAULT_NESTOR_MODEL_URL = `${NESTOR_SERVER_URL}/api/v2/cli/models`;
// [nessy-fork] user-quota-display
export const DEFAULT_NESTOR_QUOTA_URL = `${NESTOR_SERVER_URL}/api/v1/quota`;
export const DEFAULT_NESTOR_ERROR_URL = `${NESTOR_SERVER_URL}/api/v1/cli/errors`;
export const DEFAULT_NESTOR_BUG_REPORT_URL = `${NESTOR_SERVER_URL}/api/v1/cli/bug-reports`;

// [nessy-fork] external-model-mcp-whitelist
export const EXTERNAL_MODEL_MCP_WHITELIST: ReadonlySet<string> = new Set([
  'dpJira',
  'dpGitlab',
  'dpWiki',
  't-tracker',
  'dpFinedog',
  'dpSage',
  'dpAllure',
  'context7',
]);
