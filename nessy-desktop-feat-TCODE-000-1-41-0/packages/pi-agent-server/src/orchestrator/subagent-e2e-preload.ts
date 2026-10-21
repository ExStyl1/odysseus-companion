import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const faux = registerFauxProvider({
  api: 'faux',
  provider: 'faux',
  models: [{ id: 'subagent-e2e-model' }],
  tokensPerSecond: 100000,
});

faux.setResponses([
  fauxAssistantMessage(
    fauxToolCall('subagent', {
      // Explicit background:false pins the inline path this e2e streams
      // through; top-level calls otherwise default to background (S1).
      background: false,
      tasks: [
        { agent: 'scout', task: 'Return scout child output.' },
        { agent: 'reviewer', task: 'Return reviewer child output.' },
      ],
    }, { id: 'subagent-e2e-call' }),
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage('scout child output', { stopReason: 'stop' }),
  fauxAssistantMessage('reviewer child output', { stopReason: 'stop' }),
  fauxAssistantMessage('parent saw merged subagent result', { stopReason: 'stop' }),
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
