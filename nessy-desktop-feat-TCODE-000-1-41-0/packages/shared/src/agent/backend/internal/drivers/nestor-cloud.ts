import type { ProviderDriver } from '../driver-types.ts';

export const NESTOR_CLOUD_AGENT_CARD_URL =
  'https://code-completion-nestor.tcsbank.ru/api/v2/code-agent/a2a/.well-known/agent-card.json';

export const NESTOR_CLOUD_A2A_URL =
  'https://code-completion-nestor.tcsbank.ru/api/v2/code-agent/a2a';

export const nestorCloudDriver: ProviderDriver = {
  provider: 'nestor-cloud-agent',

  buildRuntime: ({ context }) => ({
    baseUrl: context.connection?.baseUrl ?? NESTOR_CLOUD_A2A_URL,
    agentCardUrl: context.connection?.baseUrl
      ? `${context.connection.baseUrl.replace(/\/$/, '')}/.well-known/agent-card.json`
      : NESTOR_CLOUD_AGENT_CARD_URL,
  }),

  validateStoredConnection: async () => ({ success: true }),

  testConnection: async () => null,
};
