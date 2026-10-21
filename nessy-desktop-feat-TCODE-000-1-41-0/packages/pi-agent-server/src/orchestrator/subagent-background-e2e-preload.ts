import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const faux = registerFauxProvider({
  api: 'faux',
  provider: 'faux',
  models: [{ id: 'subagent-e2e-model' }],
  tokensPerSecond: 100000,
});

// Default background path (S1): the top-level subagent call leaves `background`
// unset so it defaults to background — it returns a task id immediately and the
// result is retrieved later through get_subagent_result by agent_id.
faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall('subagent', {
      agent: 'scout',
      task: 'Return scout child output.',
    }, { id: 'subagent-bg-call' }),
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage(
    fauxToolCall('get_subagent_result', {
      // The harness pins the durable agent_id for the started child, so the
      // scripted model can reference it verbatim.
      agent_id: 'bg-agent-1',
      wait: true,
    }, { id: 'subagent-bg-get' }),
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage('parent retrieved background subagent result', { stopReason: 'stop' }),
]);

function installFauxModels(runtime: ModelRuntime): ModelRuntime {
  runtime.registerProvider('faux', {
    api: 'faux',
    apiKey: 'test',
    baseUrl: 'http://localhost:0',
    models: [{
      id: 'subagent-e2e-model',
      name: 'subagent-e2e-model',
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
