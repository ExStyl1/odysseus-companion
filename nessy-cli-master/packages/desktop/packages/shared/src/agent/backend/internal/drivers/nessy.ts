import type { ProviderDriver } from '../driver-types.ts';
import { fetchNessyModelsViaSharedAcp } from '../../../nessy-agent.ts';

export const nessyDriver: ProviderDriver = {
  provider: 'nessy',
  buildRuntime: ({ resolvedPaths }) => ({
    paths: {
      nessyCli: resolvedPaths.nessyCliPath,
      node: resolvedPaths.nodeRuntimePath,
    },
  }),
  fetchModels: ({ hostRuntime, timeoutMs }) =>
    fetchNessyModelsViaSharedAcp({
      hostRuntime,
      timeoutMs,
    }),
  validateStoredConnection: async () => ({
    success: true,
    shouldRefreshModels: true,
  }),
  testConnection: async () => null,
};
