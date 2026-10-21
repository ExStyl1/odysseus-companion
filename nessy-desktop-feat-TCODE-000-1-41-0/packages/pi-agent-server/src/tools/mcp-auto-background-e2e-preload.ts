import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const faux = registerFauxProvider({
  api: 'faux',
  provider: 'faux',
  models: [{ id: 'mcp-bg-e2e-model' }],
  tokensPerSecond: 100000,
});

// 'detach': two stalling calls (one settles ok, one settles with an error).
// 'off':    one stalling call with the threshold disabled - no detach.
const mode = process.env.NESSY_MCP_E2E_MODE === 'off' ? 'off' : 'detach';

faux.setResponses(mode === 'detach'
  ? [
      fauxAssistantMessage(
        fauxToolCall('mcp__stub__slow', { payload: 'first' }, { id: 'mcp-bg-e2e-call-1' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        fauxToolCall('mcp__stub__slow', { payload: 'second' }, { id: 'mcp-bg-e2e-call-2' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('mcp auto-background e2e finished', { stopReason: 'stop' }),
    ]
  : [
      fauxAssistantMessage(
        fauxToolCall('mcp__stub__slow', { payload: 'only' }, { id: 'mcp-bg-e2e-call-off' }),
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('mcp auto-background off e2e finished', { stopReason: 'stop' }),
    ]);

function installFauxModels(runtime: ModelRuntime): ModelRuntime {
  runtime.registerProvider('faux', {
    api: 'faux',
    apiKey: 'test',
    baseUrl: 'http://localhost:0',
    models: [{
      id: 'mcp-bg-e2e-model',
      name: 'mcp-bg-e2e-model',
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
