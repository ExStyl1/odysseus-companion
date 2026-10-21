/**
 * F1.803 — the preload `deferred-tool-load-real-server.test.ts` hands the REAL
 * `index.ts` subprocess. Two things are replaced and nothing else:
 *
 *   1. the model: a scripted faux provider that plays the steps in
 *      `F1803_SCRIPT` in order, one per model call, and RECORDS the tool names
 *      (and the head of the system prompt) each call was offered — the only
 *      honest instrument for "when does a loaded tool join the advertised set",
 *      because it reads what the loop actually sent, not what we meant to send;
 *   2. the web-search provider: a stub, so a `web_search` call never leaves the
 *      machine and still reaches the real tool, the real permission bridge and
 *      the real budget.
 *
 * The Pi session, its tool registry and allowlist, the deferral surface, the
 * capability catalogue and the extension registration are all the shipped code.
 * A file rather than a template literal on purpose (AGENTS.md: a backtick inside
 * a preload template closes it and the file still parses).
 */
import { mock } from 'bun:test'
import { appendFileSync } from 'node:fs'
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai/compat'
import { getCurrentSystemPrompt, getCurrentTools, type ToolCall, type TranscriptContext } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

type ScriptStep = { call?: { name: string; args: ToolCall['arguments'] }; text?: string }

const logPath = process.env.F1803_LOG
const rawScript = process.env.F1803_SCRIPT
if (!logPath || !rawScript) throw new Error('deferred-tool-load preload needs F1803_LOG and F1803_SCRIPT')
const script = JSON.parse(rawScript) as ScriptStep[]
const record = (entry: unknown) => appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
const deferredSummaryNames = (systemPrompt: string): string[] | null => {
  const block = /<deferred-tools>\n[^\n]*\n([^\n]*)\n<\/deferred-tools>/.exec(systemPrompt)
  return block ? block[1]!.split(', ') : null
}

mock.module(new URL('../../tools/search/resolve-provider.ts', import.meta.url).href, () => ({
  resolveSearchProvider() {
    return {
      name: 'f1803-stub-search',
      search: async (query: string) => {
        record({ type: 'search_ran', query })
        return [{ title: 'Bun 9.9.9', url: 'https://example.invalid/bun', snippet: 'stub result' }]
      },
    }
  },
}))

const faux = registerFauxProvider({
  api: 'faux',
  provider: 'faux',
  models: [{ id: 'f1803-model' }],
  tokensPerSecond: 100000,
})

// 0.87 moved the offered set INTO the transcript: the agent loop declares the
// deltas on system messages ("replay always yields exactly context.tools"), so
// the census is pi-ai's own replay of what THIS request's transcript declares —
// the same function the provider request itself is built from.
faux.setResponses(script.map((entry, index) => (context: TranscriptContext) => {
  const prompt = getCurrentSystemPrompt(context.messages)
  record({
    type: 'model_call',
    step: index,
    tools: getCurrentTools(context.messages).map(tool => tool.name).sort(),
    systemPromptHead: prompt.slice(0, 64),
    // F1.838 — the names line of the `<deferred-tools>` summary this call was
    // shown (`deferred-tool-summary.ts`), `null` when the prompt carries none.
    deferredSummary: deferredSummaryNames(prompt),
  })
  if (entry.call) {
    return fauxAssistantMessage(
      fauxToolCall(entry.call.name, entry.call.args, { id: `f1803-call-${index}` }),
      { stopReason: 'toolUse' },
    )
  }
  return fauxAssistantMessage(entry.text ?? 'ok', { stopReason: 'stop' })
}))

const originalCreate = ModelRuntime.create.bind(ModelRuntime)
ModelRuntime.create = (async (...args: Parameters<typeof ModelRuntime.create>) => {
  const runtime = await originalCreate(...args)
  runtime.registerProvider('faux', {
    api: 'faux',
    apiKey: 'test',
    baseUrl: 'http://localhost:0',
    models: [{
      id: 'f1803-model',
      name: 'f1803-model',
      api: 'faux',
      baseUrl: 'http://localhost:0',
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }],
  })
  return runtime
}) as typeof ModelRuntime.create

process.on('exit', () => faux.unregister())
