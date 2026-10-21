import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const faux = registerFauxProvider({
  api: 'faux',
  provider: 'faux',
  models: [{ id: 'bash-timeout-e2e-model' }],
  tokensPerSecond: 100000,
});

faux.setResponses([
  // The live tool input from CDP pass 12 (session 022b8e0b): the model passes
  // `timeout` in MILLISECONDS. 3000 must mean a 3s deadline, and that VALUE —
  // which is the whole evidence this rig was built on — is untouched.
  //
  // The COMMAND is no longer the live one verbatim, and the reason is a landed
  // row rather than convenience. The live command was
  // `for i in 1 2 3 4 5 6 7 8; do echo tick $i; sleep 1; done; echo ALL_DONE`,
  // and `d67af6f1e` made a `for`/`do`/`done` construct one of the three kinds
  // `tools-reference.md#background-commands` says are never auto-backgrounded:
  // "A compound command Claude Code can't fully parse into simple commands."
  // Measured through the production predicate, `resolveBashTimeoutBehavior`
  // answers `kill` for it — so the transition case below stopped testing the
  // transition and became a duplicate of the disable-env case beside it, which
  // would then have been passing for no reason at all.
  //
  // A list of SIMPLE commands keeps both cases honest. Keep this shape
  // parseable: no keyword, no `$(…)`, no `$((…))`, no subshell, and it must not
  // START with `sleep`. It still runs past the 3 s deadline and still ends in
  // `ALL_DONE`, which is what separates the two cases.
  fauxAssistantMessage(
    fauxToolCall('bash', {
      command: 'echo tick 1; sleep 1; echo tick 2; sleep 1; echo tick 3; sleep 1; echo tick 4; sleep 1; echo ALL_DONE',
      timeout: 3000,
    }, { id: 'bash-timeout-e2e-call' }),
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage('bash timeout-input e2e finished', { stopReason: 'stop' }),
]);

function installFauxModels(runtime: ModelRuntime): ModelRuntime {
  runtime.registerProvider('faux', {
    api: 'faux',
    apiKey: 'test',
    baseUrl: 'http://localhost:0',
    models: [{
      id: 'bash-timeout-e2e-model',
      name: 'bash-timeout-e2e-model',
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
