/**
 * Faux model for the `/subtask` real-server e2e. The command never reaches the
 * model — it is intercepted host-side and arrives as a `subtask_start` message —
 * so the scripted turn exists only to publish a capability generation, which is
 * what configures the spawner a fork then uses.
 */
import { fauxAssistantMessage, registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const faux = registerFauxProvider({
  api: 'faux',
  provider: 'faux',
  models: [{ id: 'subtask-e2e-model' }],
  tokensPerSecond: 100000,
});

faux.setResponses([
  fauxAssistantMessage('parent turn done', { stopReason: 'stop' }),
]);

function installFauxModels(runtime: ModelRuntime): ModelRuntime {
  runtime.registerProvider('faux', {
    api: 'faux',
    apiKey: 'test',
    baseUrl: 'http://localhost:0',
    models: [{
      id: 'subtask-e2e-model',
      name: 'subtask-e2e-model',
      api: 'faux',
      baseUrl: 'http://localhost:0',
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }],
  });
  return runtime;
}

// Pi 0.84 · `ModelRegistry` lost its `inMemory`/`create` statics and is now a
// synchronous facade over a `ModelRuntime`. Patching the runtime factory
// reaches every registry the process builds, which is what patching those two
// statics used to cover.
const originalCreate = ModelRuntime.create.bind(ModelRuntime);
ModelRuntime.create = (async (...args: Parameters<typeof ModelRuntime.create>) =>
  installFauxModels(await originalCreate(...args))) as typeof ModelRuntime.create;

process.on('exit', () => faux.unregister());
