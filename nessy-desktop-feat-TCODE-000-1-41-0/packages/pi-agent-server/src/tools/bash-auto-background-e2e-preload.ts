import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai/compat';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const faux = registerFauxProvider({
  api: 'faux',
  provider: 'faux',
  models: [{ id: 'bash-bg-e2e-model' }],
  tokensPerSecond: 100000,
});

faux.setResponses([
  // 1. A real command that exceeds its 1s timeout -> the documented transition.
  //    The model-facing timeout is MILLISECONDS (Claude's Bash contract).
  //
  //    A LIST OF SIMPLE COMMANDS, and that is load-bearing. This used to be a
  //    `while` loop, and `d67af6f1e` made such a command one of the three kinds
  //    `tools-reference.md#background-commands` says are never auto-backgrounded:
  //    "A compound command Claude Code can't fully parse into simple commands."
  //    So the old fixture stopped exercising the transition and started
  //    exercising the kill path — measured through the production predicate,
  //    `resolveBashTimeoutBehavior` answers `kill` for it and `background` for
  //    the line below. Keep this shape parseable: no keyword, no `$(…)`, no
  //    `$((…))`, no subshell, and it must not START with `sleep`.
  fauxAssistantMessage(
    fauxToolCall('bash', {
      command: 'echo tick-0; sleep 0.5; echo tick-1; sleep 0.5; echo tick-2; sleep 0.5; echo tick-3; sleep 0.5; echo bg-done',
      timeout: 1000,
    }, { id: 'bash-bg-e2e-timeout-call' }),
    { stopReason: 'toolUse' },
  ),
  // 2. A sleep-prefixed command is never auto-backgrounded: killed as today.
  fauxAssistantMessage(
    fauxToolCall('bash', {
      command: 'sleep 60',
      timeout: 1000,
    }, { id: 'bash-bg-e2e-sleep-call' }),
    { stopReason: 'toolUse' },
  ),
  // 3. run_in_background: immediate background start with the handle shape.
  fauxAssistantMessage(
    fauxToolCall('bash', {
      command: 'i=0; while [ $i -lt 300 ]; do echo dev-alive; i=$((i+1)); sleep 0.1; done',
      run_in_background: true,
    }, { id: 'bash-bg-e2e-background-call' }),
    { stopReason: 'toolUse' },
  ),
  // D1.108 — the OTHER TWO never-auto-background kinds. `d67af6f1e` added them
  // beside `sleep` and neither had a real-server arm: both of this wave's bash
  // rigs were exercising one of them BY ACCIDENT, and once `f60dcd2bf` and
  // `97648da02` corrected that, the production chain had an arm for the
  // `sleep`-prefixed rule and none for these. They sit AFTER the three above so
  // the existing indices do not move.
  //
  // 4. "A command that runs `git` anywhere in it." A LIST OF SIMPLE COMMANDS
  //    that does not start with `sleep`, so `commandRunsGit` is the ONLY one of
  //    the three predicates that can stop it — which is what makes this arm
  //    about that rule rather than about the others. `git --version` is a read
  //    and exits at once; the `sleep 60` after it is what carries the command
  //    past its 1s timeout so a background decision is actually reached.
  fauxAssistantMessage(
    fauxToolCall('bash', {
      command: 'echo git-arm; git --version; sleep 60',
      timeout: 1000,
    }, { id: 'bash-bg-e2e-git-call' }),
    { stopReason: 'toolUse' },
  ),
  // 5. "A compound command Claude Code can't fully parse into simple commands."
  //    A `while` keyword in COMMAND position plus `$((…))` arithmetic, and
  //    deliberately no `git` anywhere and no leading `sleep`, so this arm is
  //    about `isUnparseableCompoundCommand` alone. This is the shape arm 1 used
  //    to have, which is how the coverage was lost.
  fauxAssistantMessage(
    fauxToolCall('bash', {
      command: 'i=0; while [ $i -lt 300 ]; do echo compound-alive; i=$((i+1)); sleep 0.2; done',
      timeout: 1000,
    }, { id: 'bash-bg-e2e-compound-call' }),
    { stopReason: 'toolUse' },
  ),
  fauxAssistantMessage('bash auto-background e2e finished', { stopReason: 'stop' }),
]);

function installFauxModels(runtime: ModelRuntime): ModelRuntime {
  runtime.registerProvider('faux', {
    api: 'faux',
    apiKey: 'test',
    baseUrl: 'http://localhost:0',
    models: [{
      id: 'bash-bg-e2e-model',
      name: 'bash-bg-e2e-model',
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
