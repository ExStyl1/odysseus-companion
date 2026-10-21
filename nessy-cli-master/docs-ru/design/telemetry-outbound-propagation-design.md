# Телеметрия: распространение контекста трассировки и заголовка session ID

> Связанный issue: [#4384](https://github.com/NessyLM/nessy-cli/issues/4384)
> Родительский issue: [#3731](https://github.com/NessyLM/nessy-cli/issues/3731) (P3 deeper observability)
> Предварительный PR: #4367 (resource attributes — merged 2026-05-21, commit `64401e1`)
> Основано на состоянии main-ветви nessy-cli и прямом исследовании исходного кода claude-code от 2026-05-21

## История редакций

| Редакция | Дата       | Триггер                                       | Краткое описание                                                                                                                                                                                                                                                                  |
| -------- | ---------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1       | 2026-05-21 | Первоначальный черновик                       | Полная рассылка: все исходящие LLM-запросы включают `X-Nessy-CLI-Session-Id` + `traceparent`                                                                                                                                                                                      |
| R2       | 2026-05-22 | wenshao R2/R3 review                          | Безопасность границ: нормализация URL, сопоставление портов, цитирование, try/catch для staticCorrelationHeaders, fallback strip host:port                                                                                                                                        |
| R3       | 2026-05-23 | LaZzyMan REQUEST_CHANGES                      | **Значительное семантическое изменение**: область действия `X-Nessy-CLI-Session-Id` по умолчанию сужена до first-party (Alibaba/DashScope) хостов. См. §11                                                                                                                        |
| R4       | 2026-05-25 | LaZzyMan round-8 follow-up (conflation scope) | **Объем PR значительно сужен**: этот PR сохраняет только client HTTP span + OTLP loop guard; `traceparent` по умолчанию отключен (NoopTextMapPropagator); новое пространство имен `outboundCorrelation.*` для переключателей, связанных с безопасностью; весь код `X-Nessy-CLI-Session-Id` из R3 **удален из этого PR**, перенесен в отдельный follow-up PR. См. §12 |

**Особое примечание**: При чтении §3.1 (цели) / §3.2 (не цели) / §4.3 (дизайн Part B) / §4.4 (влияние на схему конфигурации) / §5 (список изменений файлов) / §9 (сравнение с claude-code) / §10 (будущая работа) / §11 (R3 host-allowlist scoping) обращайтесь также к §12 — **ревизия R4 делает утверждения R1-R3 о "одновременном внедрении traceparent + session id header в этом PR" недействительными**: этот PR теперь только для наблюдаемости telemetry + независимого переключателя trace-context; вся работа по correlation header (включая host allowlist из R3) перенесена в отдельный follow-up PR. Код R3 не потерян — он будет переиспользован в follow-up PR.

## 1. Предыстория

#4367 решил проблему **атрибутов и кардинальности испускаемой телеметрии** (операторы могут добавлять теги `user.id`/`tenant.id` к spans/logs/metrics). Но есть кое-что, что он не затронул: **HTTP-заголовки исходящих LLM-запросов**. Сегодня запросы nessy-cli к DashScope / OpenAI / Gemini / Anthropic **полностью лишены любых cross-process correlation header** — ни W3C `traceparent`, ни session id.

Последствия:

1. Контекст трассировки обрывается на границе процесса nessy-cli. Если сервис модели (например, DashScope с подключением ARMS Tracing) имеет собственную OTel-инструментацию, его spans и spans nessy-cli независимы, end-to-end trace tree не существует.
2. Session id отсутствует в wire. Для сопоставления метрик/логов nessy-cli с логами сервера требуется офлайн-сопоставление trace id или временных меток, что гораздо сложнее, чем простое чтение заголовка.
3. В локальной трассировке отсутствует client-side HTTP span. Сегодня можно видеть только общее время `api.generateContent`, но не сетевой TTFB / размер тела ответа / количество повторных попыток.

## 2. Текущее состояние

### 2.1 Включена только `HttpInstrumentation`

`packages/core/src/telemetry/sdk.ts:330`:

```ts
instrumentations: [new HttpInstrumentation()],
```

`HttpInstrumentation` hook'ит только встроенные модули `http`/`https` Node, **не** покрывая пути `globalThis.fetch` / undici.

### 2.2 Оба LLM SDK используют fetch / undici

| SDK                                              | HTTP реализация                                                                                                                    | Покрывается ли `HttpInstrumentation` |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `openai@5.11.0`                                  | `globalThis.fetch` (Node 18+ это undici). Доказательство: ошибка `'fetch' is not defined as a global` в `node_modules/openai/internal/shims.mjs` | ❌                                   |
| `@google/genai@1.30.0`                           | `globalThis.fetch` + `new Headers()`. Доказательство: вызов `new Headers()` в `dist/node/index.mjs`                                | ❌                                   |
| `@anthropic-ai/sdk` (anthropicContentGenerator) | Также на основе fetch                                                                                                              | ❌                                   |

### 2.3 В кодовой базе нет manual propagation

```
grep -rn "propagation\.\|setGlobalPropagator\|W3CTraceContext\|traceparent" packages/core/src --include="*.ts" | grep -v "\.test\."
```

→ Пусто. Нет вызовов `propagation.inject()`, нет ручной инъекции traceparent.

### 2.4 Текущее состояние `defaultHeaders` для каждого provider

Семейство OpenAI (использует SDK `openai`):

Все под-providers OpenAI `extends DefaultOpenAICompatibleProvider`. **Поведение override `buildHeaders` делится на две категории** (проверено аудитом grep):

| Provider   | Файл                   | Поведение `buildHeaders()`                                                                  | Влияние                                          |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Базовый    | `default.ts:63-74`     | Предоставляет `{ 'User-Agent' }` + customHeaders                                            | Изменять здесь                                   |
| DashScope  | `dashscope.ts:110-124` | **`override` без вызова `super`** — возвращает новый объект `User-Agent` + `X-DashScope-*`  | **Требуется отдельное изменение**, иначе correlation header будет потерян |
| OpenRouter | `openrouter.ts:20-30`  | `override` но **сначала `const baseHeaders = super.buildHeaders()`**                        | Изменение базового класса наследуется автоматически ✅ |
| DeepSeek   | `deepseek.ts`          | Не override `buildHeaders` (только `buildRequest` / `getDefaultGenerationConfig`)           | Изменение базового класса наследуется автоматически ✅ |
| Minimax    | `minimax.ts`           | Как deepseek                                                                                | Наследуется автоматически ✅                     |
| Mistral    | `mistral.ts`           | Как deepseek                                                                                | Наследуется автоматически ✅                     |
| ModelScope | `modelscope.ts`        | Как deepseek                                                                                | Наследуется автоматически ✅                     |

→ **Семейство OpenAI требует изменения 2 файлов**: `default.ts` и `dashscope.ts`. Остальные 5 наследуют автоматически.

Google Gemini:

| Provider | Файл                           | Путь инъекции заголовков                                             |
| -------- | ------------------------------ | -------------------------------------------------------------------- |
| Gemini   | `geminiContentGenerator.ts:59` | `new GoogleGenAI({ httpOptions: { headers } })` — нативная поддержка SDK |

Anthropic:

| Provider  | Файл                                                                                                   | Путь инъекции заголовков |
| --------- | ------------------------------------------------------------------------------------------------------ | ------------------------ |
| Anthropic | `anthropicContentGenerator.ts:177` (`buildHeaders`) + `:212` (`defaultHeaders` аргумент для `new Anthropic`) | `defaultHeaders`         |

**Всего 4 точки конструирования SDK** требуют инъекции session id header. Все SDK уже поддерживают `defaultHeaders` / `httpOptions.headers`, обертка fetch не требуется.

### 2.5 Существующая конфигурация proxy и fetch

`provider/default.ts:87-89`:

```ts
const runtimeOptions = buildRuntimeFetchOptions(
  'openai',
  this.cliConfig.getProxy(),
);
```

`buildRuntimeFetchOptions` возвращает `{ fetch: customFetch }` или аналогичное, когда пользователь настроил proxy, вызывая `setGlobalDispatcher(new ProxyAgent(...))` (см. `config.ts:1126-1128`). **Режим глобального dispatcher undici совместим с `UndiciInstrumentation`** — он работает через monkey-patch `globalThis.fetch` и диагностику каналов undici, не полагаясь на конкретный dispatcher.

## 3. Цели / Не цели

### 3.1 Цели

- Все исходящие LLM-запросы автоматически включают W3C `traceparent` header (`W3CTraceContextPropagator` по умолчанию OTel SDK)
- ~~Все~~ исходящие LLM-запросы включают header `X-Nessy-CLI-Session-Id` (продуктовое пространство имен как у claude-code) — **ревизия R3**: по умолчанию инжектируется только в first-party (Alibaba/DashScope) хосты, third-party providers по умолчанию не получают; см. §11
- Автоматическое избегание трассировки самого OTLP exporter endpoint (feedback loop)
- Добавление точного client span для LLM-запросов (разделение сетевого времени и времени модели)
- Покрытие 4 точек конструирования provider: базовый класс OpenAI, override DashScope, Gemini, Anthropic
- Все сценарии streaming-запросов / режима proxy / повторных попыток работают без деградации
- Согласованность с философией дизайна #4367: через нативные опции SDK типа `defaultHeaders` — **ревизия R1**: из-за проблемы staleness перешли на fetch wrapper; **ревизия R3**: внутри fetch wrapper добавлен host gate

### 3.2 Не цели

- **Header `baggage`**: стандартный SDK поддерживает, но nessy-cli не вызывает `propagation.setBaggage()`, по умолчанию не отправляется. Этот дизайн не включает активацию.
- **Наследование env переменной subprocess `TRACEPARENT`**: claude-code инжектирует `TRACEPARENT` для дочерних процессов Bash/PowerShell. В `BashTool` nessy-cli это не реализовано. Это отдельный follow-up sub-issue.
- **Чтение inbound `TRACEPARENT` / `TRACESTATE`**: claude-code читает traceparent из env в режиме `-p` и Agent SDK. nessy-cli не реализовано. Отдельный follow-up.
- **`X-Nessy-CLI-Request-Id`**: у claude-code есть `x-client-request-id`, полезен для correlation при обработке ошибок таймаута. Сейчас не делаем, может быть следующим sub-issue.
- **Кастомный propagator (B3 / Jaeger / X-Ray)**: W3C по умолчанию покрывает 99% сценариев. Может быть будущей опцией конфигурации.
- ~~**Выборочная инъекция per-endpoint**~~: claude-code не отправляет traceparent для third-party endpoint (Bedrock / Vertex); у nessy-cli нет разделения third-party, отправляем везде. — **Ревизия R3**: это утверждение опровергнуто. LaZzyMan review указал, что nessy-cli — это open-source CLI, подключающийся к нескольким third-party provider (OpenAI / Anthropic / OpenRouter / и др.), аналогия claude-code first-party→first-party неприменима; session id header должен различаться по хосту. См. §11. `traceparent` по-прежнему инжектируется везде по дизайну R1 (стандартный OTel header, trace id — хэш `sha256(sessionId)`), может быть добавлен per-destination toggle ( `telemetry.propagateTraceContext`) как независимый follow-up.

## 4. Дизайн

### 4.1 Общая分层

```
┌─ процесс nessy-cli ────────────────────────────────────────────┐
│                                                                │
│  ┌─ session-tracing.ts ─┐                                     │
│  │ active span ctx      │                                     │
│  └──────┬───────────────┘                                     │
│         │                                                      │
│         ▼                                                      │
│  ┌─ propagation.inject() (вызывается undici instrumentation) ─┐│
│  │ записывает `traceparent: 00-<traceId>-<spanId>-01` в headers ││
│  └─────────────────────────────────────────────────────────────┘│
│         │                                                      │
│  ┌──────▼──────────────────────────────────────────────────┐  │
│  │   fetch() — undici, instrumented                        │  │
│  │   создает HTTP client span                              │  │
│  │   инжектирует traceparent в request headers             │  │
│  │   (пропускается через ignoreRequestHook, если endpoint OTLP)   │
│  └─────────────────────────────────────────────────────────┘  │
│         │                                                      │
│         │   ┌─ defaultHeaders (на конструктор SDK) ───────┐  │
│         │   │ { 'X-Nessy-CLI-Session-Id': sessionId, ... } │  │
│         └───┴────────────────────────────────────────────────┘ │
│             │                                                  │
└─────────────┼──────────────────────────────────────────────────┘
              │
              ▼ исходящий HTTP
   POST /v1/chat/completions
   traceparent: 00-...
   X-Nessy-CLI-Session-Id: ...
   ... (существующие User-Agent, X-DashScope-*, etc.)
```

Два независимых пути инъекции:

| Layer                    | Когда инжектируется                   | Кто инжектирует                                                |
| ------------------------ | ------------------------------------- | -------------------------------------------------------------- |
| `traceparent`            | При каждом вызове fetch               | `UndiciInstrumentation` автоматически (из propagator по умолчанию OTel SDK) |
| `X-Nessy-CLI-Session-Id` | При конструировании SDK, один раз в `defaultHeaders` | Код приложения                                                      |

### 4.2 Part A — `traceparent` через undici instrumentation

**Точка изменения**: `packages/core/src/telemetry/sdk.ts`

```ts
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

// ...
const otlpUrls = [
  config.getTelemetryOtlpEndpoint(),
  config.getTelemetryOtlpTracesEndpoint(),
  config.getTelemetryOtlpLogsEndpoint(),
  config.getTelemetryOtlpMetricsEndpoint(),
]
  .filter((u): u is string => !!u)
  .map((u) => u.replace(/\/$/, ''));

instrumentations: [
  new HttpInstrumentation(),
  new UndiciInstrumentation({
    ignoreRequestHook: (request) => {
      // request.origin = "https://collector:4318", request.path = "/v1/traces"
      const url = `${request.origin}${request.path}`;
      return otlpUrls.some((e) => url.startsWith(e));
    },
  }),
],
```

#### Почему необходим `ignoreRequestHook`

OTel SDK сам использует fetch для POST данных в OTLP collector. Если не пропустить, UndiciInstrumentation создаст span для запроса "отправки данных" → этот новый span будет отправлен снова → бесконечный цикл / огромный шум. Каждый OTel проект наступал на эти грабли, документация OTel явно рекомендует такой hook.

#### Propagator по умолчанию

OTel SDK `NodeSDK` при отсутствии переданного `textMapPropagator` по умолчанию использует `CompositePropagator([W3CTraceContextPropagator, W3CBaggagePropagator])`. Явная установка не требуется.

#### Формат `traceparent`

```
traceparent: 00-<32hex traceId>-<16hex spanId>-<01 sampled | 00 not sampled>
              ─┬─                                          ─┬─
               version (фиксировано 00)                    flags
```

Фиксировано 55 bytes, без padding.

#### `tracestate` и `baggage`

- `tracestate`: передается только если пришел от upstream; при inject самостоятельно не добавляется (поведение OTel SDK).
- `baggage`: появляется только при вызове `propagation.setBaggage(ctx, ...)`. nessy-cli не вызывает, поэтому не отправляется.

### 4.3 Part B — `X-Nessy-CLI-Session-Id` через fetch wrapper (OpenAI / Anthropic) + static headers (Gemini)

> **Ревизия R3**: следующее описание сохраняет fetch wrapper для решения проблемы staleness и 4 точек интеграции provider — все это сохраняется. Но внутри wrapper добавлен host allowlist gate, в `staticCorrelationHeaders` также добавлен параметр `destinationUrl`. Актуальный код реализации с host gate и default allowlist см. в §11.

#### Критично: проблема staleness и выбор решения

Наивный подход (`defaultHeaders` напрямую bake-in `getSessionId()`) имеет **реальный баг**:

1. `pipeline.ts:60` конструирует `this.client = this.config.provider.buildClient()` один раз при создании contentGenerator, `defaultHeaders` SDK client захватывает session id на тот момент
2. Session reset в `config.ts:1850` (срабатывает при `/clear` пользователем) обновляет `this.sessionId` и вызывает `refreshSessionContext()`, но **не пересоздает contentGenerator**
3. Последующие LLM-вызовы используют старый client → wire header остается старым session id → корреляция на бэкенде нарушена

→ Необходимо читать session id **per-request**, нельзя bake-in при конструировании.

#### Решение

```
                   ┌─ Поддержка fetch ─┐  Решение
OpenAI SDK          │     ✅            │  fetch wrapper (per-request чтение sessionId) ✅
Anthropic SDK       │     ✅            │  fetch wrapper ✅
@google/genai SDK   │     ❌            │  static httpOptions.headers + приемлем staleness
                   └───────────────────┘
```

Интерфейс `HttpOptions` для `@google/genai` не поддерживает `fetch` (проверено grep `node_modules/@google/genai/dist/genai.d.ts`: только `baseUrl`/`apiVersion`/`headers`/`timeout`/`extraParams`). Поэтому Gemini идет через static headers, что несовместимо с OpenAI/Anthropic — это **known limitation**, см. §8.6.

#### Вспомогательная функция (fetch wrapper per-request)

Новый файл `packages/core/src/telemetry/llm-correlation-fetch.ts`:

```ts
import type { Config } from '../config/config.js';

/**
 * Обертка fetch так, чтобы каждый исходящий запрос получал correlation
 * заголовки (`X-Nessy-CLI-Session-Id`), заполненные из **текущего** session
 * id, а не значения, захваченного при конструировании SDK client.
 *
 * Соответствует паттерну claude-code (src/services/api/client.ts:370-390 —
 * `buildFetch()`). Per-request injection необходим, потому что `/clear`
 * сбрасывает session id в середине процесса; SDK clients (и их статические
 * `defaultHeaders`) НЕ пересоздаются при сбросе.
 *
 * Вызывающая сторона отвечает за выбор базового fetch — обычно
 * `runtimeOptions?.fetch ?? globalThis.fetch`, чтобы proxy-aware fetch
 * сохранялся при использовании ProxyAgent.
 *
 * Если телеметрия отключена, возвращает baseFetch без изменений (никакой correlation
 * header не добавляется, что соответствует privacy stance из §3.1).
 */
export function wrapFetchWithCorrelation(
  baseFetch: typeof fetch,
  config: Config,
): typeof fetch {
  return async function correlationFetch(input, init) {
    if (!config.getTelemetryEnabled()) {
      return baseFetch(input, init);
    }
    const sid = config.getSessionId();
    if (!sid) {
      // Defensive: пустое значение header отклоняется некоторым HTTP middleware.
      // Пропускаем инъекцию вместо отправки `X-Nessy-CLI-Session-Id: `.
      return baseFetch(input, init);
    }
    const headers = new Headers(init?.headers);
    headers.set('X-Nessy-CLI-Session-Id', sid);
    return baseFetch(input, { ...init, headers });
  };
}
```

Вспомогательная функция для SDK, которые могут принимать только static headers (Gemini):

```ts
/**
 * Статические correlation заголовки. Захватывает session id на момент вызова —
 * **подвержено staleness**, если host SDK хранит эти заголовки в захваченном
 * при конструировании слоте (например, `httpOptions.headers` в `@google/genai`).
 * Предпочитайте `wrapFetchWithCorrelation` когда SDK предоставляет `fetch` hook.
 */
export function staticCorrelationHeaders(
  config: Config,
): Record<string, string> {
  if (!config.getTelemetryEnabled()) return {};
  return { 'X-Nessy-CLI-Session-Id': config.getSessionId() };
}
```

#### Точка интеграции 1: `provider/default.ts` (базовый класс OpenAI)

Изменения в `buildClient()` — композиция существующего `runtimeOptions.fetch` (proxy) с нашим wrapper:

```ts
buildClient(): OpenAI {
  // ... existing ...
  const runtimeOptions = buildRuntimeFetchOptions('openai', this.cliConfig.getProxy());
  const baseFetch =
    (runtimeOptions as { fetch?: typeof fetch } | undefined)?.fetch
    ?? globalThis.fetch;
  return new OpenAI({
    apiKey,
    baseURL: baseUrl,
    timeout,
    maxRetries,
    defaultHeaders,
    ...(runtimeOptions || {}),
    // После spread, переопределяем `fetch` чтобы наш correlation wrapper
    // оборачивал proxy-aware fetch (или globalThis.fetch без proxy).
    fetch: wrapFetchWithCorrelation(baseFetch, this.cliConfig),
  });
}
```

`buildHeaders()` без изменений.

#### Точка интеграции 2: `provider/dashscope.ts` (override)

Та же композиция в `buildClient()` (он уже override buildClient). `buildHeaders()` без изменений.

#### Точка интеграции 3: `geminiContentGenerator/index.ts` (factory, НЕ конструктор)

**Исправление предыдущего перепроектирования**: конструктор `geminiContentGenerator.ts` **не требует** изменения сигнатуры. Factory функция в `index.ts:48` уже получает `gcConfig: Config` (строка 33 уже использует `gcConfig?.getUsageStatisticsEnabled()`), нужно только merge correlation static headers в `httpOptions.headers` внутри factory:

```ts
// geminiContentGenerator/index.ts
let headers: Record<string, string> = { ...baseHeaders };
if (gcConfig?.getUsageStatisticsEnabled()) {
  // ... existing x-gemini-api-privileged-user-id ...
}
headers = { ...headers, ...staticCorrelationHeaders(gcConfig) }; // ←新增
const httpOptions = config.baseUrl
  ? { headers, baseUrl: config.baseUrl }
  : { headers };
// new GeminiContentGenerator(...) без изменений
```

Никаких изменений сигнатур.

#### Точка интеграции 4: `anthropicContentGenerator.ts`

Anthropic SDK также принимает custom `fetch` (уже использует `buildRuntimeFetchOptions`). Обернем fetch в пути `buildClient` тем же способом, что и OpenAI default.ts. `buildHeaders` без изменений.

#### Цепочка приоритетов

Пользовательские `customHeaders` по-прежнему выигрывают при merge `defaultHeaders` (см. обсуждение spoofing в §8.2). Инжектируемый fetch wrapper `X-Nessy-CLI-Session-Id` добавляется в объект `Headers` **после** headers списка SDK — по семантике Node `Headers.set()` это означает перезапись любого предыдущего同名 header (включая同名 header из user customHeaders).

**Для OpenAI/Anthropic (путь fetch wrapper)**: correlation > customHeaders > SDK defaults.
**Для Gemini (путь static headers)**: customHeaders > correlation > SDK defaults (сохраняется существующий порядок spread).

Разница в том, что при пути fetch wrapper spoofing больше невозможен (fetch wrapper запускается после headers SDK). Это **побочный продукт исправления бага**, не преднамеренное ужесточение — но безопаснее. Явно укажем в §8.2.

### 4.4 Влияние на схему конфигурации

~~**Почти отсутствует**. Этот дизайн не вводит новые настройки~~ — **Ревизия R3**: введена новая настройка `telemetry.sessionIdHeaderHosts: string[]` для переопределения default first-party host allowlist. Элемент схемы добавлен в `packages/cli/src/config/settingsSchema.ts`, описание и синтаксис override (`["*"]` восстановить рассылку / `[]` полностью отключить / кастомный массив) см. в §11. Оригинальное описание ниже применимо только до R3:

- Инъекция `traceparent` триггерится включением telemetry (существующий toggle)
- Инъекция `X-Nessy-CLI-Session-Id` также триггерится включением telemetry
- OTLP url для `ignoreRequestHook` уже читается из существующей конфигурации

Будущие возможные настройки (**out of scope**):

- `telemetry.outboundCorrelationHeader`: кастомное имя header (по умолчанию `X-Nessy-CLI-Session-Id`)
- `telemetry.outboundPropagationDisabled`: глобальное отключение (если LLM сервис строг к неизвестным header)
- ~~per-destination header scope toggle~~ — **R3 реализовано**, см. §11

## 5. Список изменений файлов

| Файл                                                                            | Тип изменения | Описание                                                                                                                                                            |
| ------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/package.json`                                                    | Добавление зависимости   | `@opentelemetry/instrumentation-undici`                                                                                                                         |
| `packages/core/src/telemetry/sdk.ts`                                            | Изменение     | +`UndiciInstrumentation` + `ignoreRequestHook`                                                                                                                  |
| `packages/core/src/telemetry/llm-correlation-fetch.ts`                          | Новый файл   | `wrapFetchWithCorrelation()` (OpenAI/Anthropic) + `staticCorrelationHeaders()` (Gemini fallback)                                                                |
| `packages/core/src/core/openaiContentGenerator/provider/default.ts`             | Изменение     | `buildClient()` добавляет `fetch: wrapFetchWithCorrelation(baseFetch, cliConfig)` в `new OpenAI({...})`                                                             |
| `packages/core/src/core/openaiContentGenerator/provider/dashscope.ts`           | Изменение     | То же (override `buildClient`)                                                                                                                                  |
| `packages/core/src/core/geminiContentGenerator/index.ts`                        | Изменение     | merge `staticCorrelationHeaders(gcConfig)` в `httpOptions.headers` внутри factory функции (**Config уже есть у caller, никаких изменений сигнатуры — исправление предыдущего over-specification**) |
| `packages/core/src/core/anthropicContentGenerator/anthropicContentGenerator.ts` | Изменение     | Использует `wrapFetchWithCorrelation` для обертки `fetch` опции SDK в пути `buildClient`                                                                                      |

**Явно аудировано, но не требует изменений** (чтобы reviewer не сомневался в пропущенных путях):

- `packages/core/src/nessy/nessyContentGenerator.ts` — `extends OpenAIContentGenerator`, использует `DashScopeOpenAICompatibleProvider`, **автоматически наследует изменения dashscope.ts buildClient**. Все DP Auth flows также получают выгоду.
- `packages/core/src/core/loggingContentGenerator/loggingContentGenerator.ts` — wrapper模式, не конструирует SDK client (он оборачивает другие contentGenerator для telemetry logging), не требует изменений.
- `packages/core/src/core/contentGenerator.ts` — factory entry, не держит client.
  | `packages/core/src/telemetry/sdk.test.ts` | Изменение | Добавлен тест регистрации undici instrumentation + ignoreRequestHook |
  | `packages/core/src/telemetry/llm-correlation-fetch.test.ts` | Новый файл | Юнит-тест поведения telemetry-on/off + проверка per-request чтения sessionId (критично: после session reset wrapped fetch читает новый id) |
  | `*.test.ts` каждого provider | Изменение | Утверждение, что опция `fetch` при конструировании SDK — wrapped версия (OpenAI/Anthropic); утверждение, что `httpOptions.headers` при конструировании Gemini содержит `X-Nessy-CLI-Session-Id` |
  | `docs/developers/development/telemetry.md` | Изменение | Новый раздел "Trace context & session correlation propagation" |
  | `docs/design/telemetry-outbound-propagation-design.md` | Этот файл | Документ дизайна |

## 6. Разбиение на PR

По дружелюбности к review делим на два PR (можно объединить, масштаб позволяет):

### PR 1 — Автоматическая инъекция `traceparent` (structural)

- Добавление зависимости `@opentelemetry/instrumentation-undici`
- `sdk.ts` добавляет `UndiciInstrumentation` + `ignoreRequestHook`
- Тесты: регистрация SDK, OTLP endpoint не трассируется
- Фрагмент документации

**Риск**: низкий. Аддитивно. Существующий client span — чистый выигрыш, не меняет существующую структуру span.

### PR 2 — Header `X-Nessy-CLI-Session-Id` (в сочетании с helper функциями)

- Новый файл `llm-correlation-headers.ts`
- 4 точки интеграции provider
- Тесты: утверждение наличия header для каждого provider; не отправляется при telemetry-off
- Фрагмент документации

**Риск**: низкий-средний. Нужно быть осторожным с расширением сигнатуры конструктора `geminiContentGenerator`, которое может затронуть вызывающие стороны.

### PR 3 (опционально) — Документация + E2E verify

- Дополнение раздела `telemetry.md`
- Добавление скрипта E2E verify (по образцу `/tmp/verify-telemetry-pr-4367.mjs`): реальный запуск fetch + перехват header

Можно также объединить с PR 2.

### Предпочтительный порядок

PR 1 и PR 2 технически **независимы** — не共享代码. Но**рекомендуется сначала PR 1**:

- `traceparent` — это **стандартный** OTel header, любой OTel-aware collector / бэкенд немедленно распознает → пользователь немедленно получает выгоду
- `X-Nessy-CLI-Session-Id` — **кастомный** header продукта, требует конфигурации бэкенда для ценности → ценность отложена
- В случае если review PR 2 затянется, PR 1 уже запустит cross-process trace
- PR 1 — аддитивный structural (низкий риск), подходит для建立 уверенности сначала

## 7. План тестирования

### 7.1 Юнит-тесты `sdk.ts`

- ✅ `UndiciInstrumentation` присутствует в `instrumentations` `NodeSDK`
- ✅ `ignoreRequestHook` возвращает true для `https://collector:4318/v1/traces`
- ✅ `ignoreRequestHook` возвращает false для `https://dashscope.aliyuncs.com/...`
- ✅ trailing slash и без trailing slash корректно сопоставляются

### 7.2 Юнит-тесты `llm-correlation-fetch.ts`

**`wrapFetchWithCorrelation`**:

| Сценарий                                                    | Ожидание                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `getTelemetryEnabled() === false`                           | wrapped fetch = baseFetch (без добавления header)                           |
| `getTelemetryEnabled() === true`, sessionId = "abc-123"     | wrapped fetch отправляет init.headers с `X-Nessy-CLI-Session-Id: abc-123` |
| `init.headers` уже имеет `X-Nessy-CLI-Session-Id: spoof`    | wrapper перезаписывает на настоящий sessionId (путь fetch wrapper не позволяет spoof, §8.1)   |
| **wrapped fetch вызван повторно после session reset**       | **читает новый sessionId** (regression guard для исправления staleness)             |
| baseFetch reject                                            | wrapper пропускает reject без поглощения                                               |

**`staticCorrelationHeaders`** (путь Gemini):

| Сценарий                                                    | Ожидаемый возврат                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| `getTelemetryEnabled() === false`                           | `{}`                                                             |
| `getTelemetryEnabled() === true`, sessionId = "abc-123"     | `{ 'X-Nessy-CLI-Session-Id': 'abc-123' }`                        |
| sessionId содержит unicode (`會話 -1`)                      | Возврат как есть — кодирование HTTP header value на стороне SDK                      |
| sessionId — пустая строка                                   | `{ 'X-Nessy-CLI-Session-Id': '' }` — business invariant, не проверяется на этом уровне |

### 7.3 Интеграционные тесты Per-provider

Для каждого provider добавить тесты `buildHeaders()` / конструирования:

```ts
it('includes X-Nessy-CLI-Session-Id when telemetry enabled', () => {
  const config = makeFakeConfig({
    sessionId: 'sess-xyz',
    telemetry: { enabled: true },
  });
  const provider = new DefaultProvider(genConfig, config);
  expect(provider.buildHeaders()['X-Nessy-CLI-Session-Id']).toBe('sess-xyz');
});

it('omits X-Nessy-CLI-Session-Id when telemetry disabled', () => {
  const config = makeFakeConfig({ telemetry: { enabled: false } });
  const provider = new DefaultProvider(genConfig, config);
  expect(provider.buildHeaders()).not.toHaveProperty('X-Nessy-CLI-Session-Id');
});
```

### 7.4 E2E верификация (tmux + local HTTP server)

⚠️ **Не** mock'ить `globalThis.fetch` для перехвата header: `UndiciInstrumentation` hook'ит через diagnostics channel undici, monkey-patching globalThis.fetch может полностью bypass instrumentation (зависит от порядка patch), и инъекция `traceparent` не будет протестирована. **Правильный подход — запустить local HTTP server**, чтобы SDK реально отправлял запросы, server записывает полученные headers.

Написать скрипт по образцу `/tmp/verify-telemetry-pr-4367.mjs`:

1. `http.createServer((req, res) => { capturedHeaders.push(req.headers); res.end('{}') })` запуск локального server
2. Включить telemetry + outfile + указать `baseURL` OpenAI SDK на `http://127.0.0.1:<port>` (или использовать mock provider для реальной отправки fetch SDK)
3. Запустить один раз `client.chat.completions.create(...)` (требуется минимальный mock response для парсинга, иначе SDK выдаст ошибку — локальный server возвращает валидный, но пустой OpenAI response)
4. Утверждать, что `capturedHeaders[0]` содержит `traceparent: 00-...` и `X-Nessy-CLI-Session-Id: <sessionId>`
5. Запустить другой mock OTLP collector на другом порту, проверить, что отправка OTLP данных **не** вызывает инъекцию `traceparent` (проверка `ignoreRequestHook`)
6. **Дополнительно: проверка staleness** — emit request 1 → call `config.resetSession(...)` → emit request 2 → утверждать, что `X-Nessy-CLI-Session-Id` request 2 — это новый session id (**это ключевой регрессионный тест для фикса #1**)

### 7.5 Регрессионная защита

- Fetch streaming chat completion (с `stream: true`) корректно закрывается — у `UndiciInstrumentation` исторически были баги с lifecycle span для streaming response, **при реализации нужно реально запустить streaming completion end-to-end для проверки, что client span нормально завершается + нет leaked span + поток не обрезан**; не предполагаем, что конкретная версия исправила
- Режим proxy (`ProxyAgent`) и instrumentation включены одновременно — `ignoreRequestHook` все еще сопоставляет по строке endpoint, proxy не влияет
- При повторных попытках (`maxRetries`) каждая попытка получает независимый client span, но все разделяют один `traceparent` parent (в идеале retry — это несколько child span под одним parent span — это определяется поведением SDK, этот дизайн не форсирует)

## 8. Граничные / угловые случаи

### 8.1 Несоответствие поведения override customHeaders и spoofing

Разные пути provider **различаются** по возможности spoofing (следствие дизайна, не преднамеренное ужесточение):

| Путь provider                           | Возможен ли spoofing? | Причина                                                                                                                |
| --------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| OpenAI / Anthropic (путь fetch wrapper) | ❌ Нельзя spoof       | fetch wrapper делает `headers.set('X-Nessy-CLI-Session-Id', ...)` после списка headers SDK, перезаписывая同名 user customHeaders |
| Gemini (путь static headers)            | ✅ Можно spoof        | Порядок merge `{ ...baseHeaders, ...correlationHeaders, ...customHeaders }` — customHeaders выигрывают последними      |

claude-code также использует путь fetch wrapper, поведение совпадает с OpenAI/Anthropic (spoofing невозможен). Это побочный продукт исправления бага staleness, не изначальная цель.

**Не планируем "выравнивать" два пути** — поведение пути Gemini вызвано ограничением SDK (отсутствует `fetch` hook), обратное понижение OpenAI до static нелогично.

Spoofing session id не является реальной угрозой (пользователь контролирует локальную машину, может напрямую изменить исходный код). В документации нужно явно указать это различие, чтобы reviewer не подвергал сомнению приоритет customHeaders при невозможности spoofing на пути fetch wrapper.

### 8.2 Два типа edge case сопоставления URL OTLP collector

#### (a) Auth token в URL

Если endpoint OTLP пользователя имеет вид `https://collector/path?token=secret`, `ignoreRequestHook` с `url.startsWith(e)` будет сопоставлять включая query string. Но `request.path` от undici содержит только path (без query), поэтому при сравнении `e` используется только path часть. Для безопасности обрезаем query:

```ts
const otlpUrls = [...]
  .map((u) => u.replace(/\?.*$/, '').replace(/\/$/, ''));
```

#### (b) Теоретический false positive startsWith через границы hostname

Если `e = "http://collector"` (без порта), incoming url = `http://collector-fake/v1/traces` будет ошибочно сопоставлен startsWith.

**Вероятность срабатывания крайне низка**:

- OTLP endpoint почти всегда с портом (4317 gRPC / 4318 HTTP), после формы `http://collector:4318` продолжение типа `-fake` невозможно (после порта следует `/`)
- Конфигурация endpoint пользователем без порта — это ошибка конфигурации, SDK все равно сделает fallback по умолчанию

**Если хочется harden**: распарсить URL origin + path отдельно, не использовать голый startsWith:

```ts
const parsed = otlpUrls.map((u) => new URL(u));
return parsed.some(
  (e) =>
    `${request.origin}` === e.origin && request.path.startsWith(e.pathname),
);
```

Сейчас не делаем — overhead не нужен, false positive практически не срабатывает.

### 8.3 Режим Vertex AI для Gemini

`@google/genai` поддерживает режим `vertexai: true` (использует GCP credentials через Vertex endpoint вместо generative ai endpoint). Оба режима используют fetch, поэтому instrumentation покрывает оба. `httpOptions.headers` работает в обоих режимах.

### 8.4 Существующая логика `defaultHeaders` в Anthropic SDK

`anthropicContentGenerator.ts:177` уже вызывает `buildHeaders()` и передает в `new Anthropic({ defaultHeaders })`. Но staleness применимо и здесь — этот дизайн меняет путь на `fetch` wrapper (как OpenAI).

### 8.5 Trailer headers между SDK и fetch

SDK `openai` при streaming может использовать `Transfer-Encoding: chunked` и trailer headers. Это не влияет на инъекцию `traceparent` / `X-Nessy-CLI-Session-Id` во время request — все это request headers, записываются один раз при отправке.

### 8.6 ⚠️ Known limitation: session id для Gemini stale после `/clear`

Поскольку SDK `@google/genai` не поддерживает `fetch` hook (интерфейс `HttpOptions` содержит только `baseUrl`/`apiVersion`/`headers`/`timeout`/`extraParams`), провайдер Gemini идет через static `httpOptions.headers` — session id захватывается при конструировании SDK, **не обновляется после session reset при `/clear`**.

**Фактическая область влияния**:

- Пользователь запускает nessy-cli → `/clear` → использует модель Gemini → `X-Nessy-CLI-Session-Id` в wire — старый session id
- Корреляция на бэкенде нарушена (trace id и log уже правильно переключились на новый session, но wire header отстает)

**Почему не чиним** (в этом цикле):

- Пути OpenAI / Anthropic **не имеют этого бага** (путь fetch wrapper читает session id per-request)
- Варианты фикса для Gemini есть, все выходят за рамки этого цикла (см. ниже)

**Варианты будущего фикса** (по порядку рекомендации):

| Вариант                                       | Описание                                                                                 | Цена                                                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **A. Lazy invalidate** ★ рекомендуется        | При session reset только mark contentGenerator dirty, при следующем LLM вызове lazy recreate        | Мала: ~10 строк в `resetSession` + entry LLM вызова; синхронный API, без вторжения                            |
| B. Eager recreate                             | При session reset немедленно `await createContentGenerator(...)}`, требуется async `resetSession` | Средня: изменения API каскадом по многим местам                                                                      |
| C. Proxy headers object                       | Обернуть `httpOptions.headers` в Proxy для перехвата getter                                        | Высокий риск: неизвестно, читает ли `@google/genai`内部 per-request headers, поведение может silently break |
| D. Продвинуть upstream `@google/genai` добавить `fetch` option | Предложить PR в google-deepmind/generative-ai-js                                            | Долгосрочно; неконтролируемо                                                                              |

**Документация должна объяснить пользователю**: при использовании провайдера Gemini, если сразу после `/clear` есть LLM вызов, session id в wire в этот момент старый. Можно исправить через trace correlation (session.id на spans/logs уже новый).

Следует завести отдельный follow-up sub-issue для отслеживания варианта A.

## 9. Сравнение с claude-code

| Измерение                         | claude-code                                                                                                                                          | Дизайн nessy-cli                                                                                                                                                              | Обоснование решения                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Имя заголовка Session id          | `X-Claude-Code-Session-Id` (префикс продукта)                                                                                                       | `X-Nessy-CLI-Session-Id` (префикс продукта)                                                                                                                                          | ✅ Одинаковая стратегия именования пространства                                                                                                                |
| Механизм инъекции Session id      | SDK `defaultHeaders` (`client.ts:108`) + кастомный `buildFetch()` wrapper (`client.ts:370-390`, per-request `randomUUID()` инъекция `x-client-request-id`) | OpenAI/Anthropic через fetch wrapper (per-request чтение session id, избежание `/clear` staleness); Gemini через static `httpOptions.headers` (ограничение SDK)                                   | Выравнивание с режимом fetch wrapper claude-code. claude-code также использует fetch wrapper для per-request добавления `x-client-request-id`                 |
| Постоянство Session id            | claude-code нет session reset типа `/clear`; session = process                                                                                        | Есть `/clear` reset → путь fetch wrapper автоматически следует; путь static headers stale (§8.6)                                                                                           | Уникальная сложность nessy-cli                                                                                                             |
| Кодирование Session id            | HTTP header (не baggage)                                                                                                                          | HTTP header                                                                                                                                                                   | ✅ Одинаково — backend friendly                                                                                                                |
| Инъекция `traceparent`            | Закрыто; публичные docs упоминают; в открытом репо нет ссылок на `propagation.inject` / `UndiciInstrumentation`                                                           | `@opentelemetry/instrumentation-undici` автоматически                                                                                                                                  | Как реализовано в claude-code — неизвестно. Мы выбираем официальный путь OTel, легче                                                                       |
| Область отправки `traceparent`    | Только first-party Anthropic API; не отправляется Bedrock/Vertex/Foundry                                                                 | Отправляется всем исходящим fetch (W3C стандарт; trace id — хэш `sha256(sessionId)`). **Ревизия R3**: session id header инжектируется только в first-party (Alibaba/DashScope) allowlist, third-party по умолчанию не отправляются. См. §11 | После R3 session header nessy-cli имеет ту же first-party-only семантику, что и claude-code; `traceparent` все еще ожидает per-destination toggle follow-up |
| `x-client-request-id` (случайный) | Есть, автоматически                                                                                                                                             | Сейчас не делаем (отдельный follow-up sub-issue имеет более высокую ценность)                                                                                                                                   | Контроль области                                                                                                                           |
| Env подпроцесса `TRACEPARENT`     | Документация подтверждает существование (реализация закрыта)                                                                                                                      | Не делаем (отдельный follow-up)                                                                                                                                                        | Контроль области                                                                                                                           |
| Чтение inbound `TRACEPARENT`      | Документация подтверждает существование (режим `-p` / Agent SDK)                                                                                                                | Не делаем (отдельный follow-up)                                                                                                                                                        | Контроль области                                                                                                                           |

**Примечание verified vs documented**:

| Утвервление                                           | Статус проверки                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Claude-Code-Session-Id` через `defaultHeaders` | ✅ Открытый исходный `src/services/api/client.ts:108` прочитано                                                                                              |
| `x-client-request-id` через fetch wrapper         | ✅ Открытый исходный `src/services/api/client.ts:370-390` прочитано                                                                                          |
| Инъекция `traceparent`                              | ⚠️ Только docs.claude.com/docs/en/monitoring-usage.md упоминает; открытый репо `grep -rn "propagation\.inject\|UndiciInstrumentation\|traceparent" src` возвращает пусто |

## 10. Будущая работа

В рамках #3731 P3, этот дизайн **не включает**, но связан:

- **`X-Nessy-CLI-Request-Id`** случайный UUID per request (эквивалент claude-code: `x-client-request-id`). Полезен для correlation ошибок таймаута/timeout — при таймауте сервер может еще не назначить request id, id клиента — единственное средство связи. После ревизии R3 это предложение становится еще более значимым: per-request UUID не имеет риска "профилирования cross-request", может быть как "вспомогательный/отладочный header для всех LLM provider".
- **Per-destination scope toggle для `traceparent`** — ревизия R3 обрабатывает только область действия session id header; `traceparent` все еще инжектируется всем исходящим fetch. Можно добавить `telemetry.propagateTraceContext: 'trusted-hosts' | 'all' | 'none'`, используя тот же allowlist из §11 для определения поведения.
- **Исправление staleness session id для Gemini lazy-invalidate** (вариант A из §8.6): при `/clear` mark contentGenerator dirty, при следующем LLM вызове lazy recreate. Чтобы путь Gemini также получил выгоду от实时ности fetch wrapper.
- **Env подпроцесса `TRACEPARENT`**: инжектировать env при выполнении `BashTool` для дочерних процессов, чтобы внешние инструменты могли продолжить trace. Требуется отдельный просмотр tool execution lifecycle.
- **Inbound `TRACEPARENT`**: при запуске режима `--prompt` читать env, чтобы CI / внешний orchestrator могли подключить nessy-cli к большему trace.
- **Настраиваемое имя `correlationHeader`**: позволить enterprise ops кастомизировать header (по умолчанию `X-Nessy-CLI-Session-Id`).
- **Стратегия propagation `baggage`**: активно устанавливать baggage для передачи `user.id` / `tenant.id` и т.д. downstream. Сейчас не делаем, ждем явных требований.

## 11. Ревизия R3 — Host-Allowlist Scoping для `X-Nessy-CLI-Session-Id`

> Триггер: [REQUEST_CHANGES review LaZzyMan в PR #4390](https://github.com/NessyLM/nessy-cli/pull/4390)
> Реализация commit: `1c8528a56` (базовая реализация) + `cb162e716` (fail-closed для Vertex baseUrl +容错`["*"]` trim)

### 11.1 Триггер и обоснование

Дизайн R1 инжектировал `X-Nessy-CLI-Session-Id` во **все** исходящие LLM-запросы, управляется только `telemetry.enabled`. LaZzyMan review указал на три последовательные проблемы:

1. **Смещение标签**: `feat(telemetry):` + путь `telemetry/` + gate `getTelemetryEnabled()` заставляет пользователя разумно предположить "поток данных собственной наблюдаемости в собственный collector". Но `X-Nessy-CLI-Session-Id` не попадает в OTLP backend, он идет в LLM API запросах к DashScope / OpenAI / Anthropic / Gemini / OpenRouter / MiniMax / ModelScope / Mistral. Два разных решения об出口 данных привязаны к одному переключателю.

2. **Аналогия claude-code неприменима**: R1 в §9 "выровнял" стратегию именования и режим fetch wrapper с claude-code. Но claude-code — это Anthropic一方 → Anthropic一方 (single vendor, single direction), nessy-cli — open-source CLI → несколько third-party provider. "Стабильный cross-request UUID, рассылаемый всем third-party" — вопрос, на который R1 не ответил прямо.

3. **traceparent — это другой канал того же отпечатка**: trace id = `sha256(sessionId).slice(0, 32)`, для получателя все еще стабильный per-session идентификатор (необратим после хэширования, но все еще стабилен для同一 session).

LaZzyMan оценил severity: session id `high` / traceparent `medium`.

### 11.2 Обзор решения

**Сузить область действия по умолчанию до first-party hosts**. Добавить новую настройку:

```jsonc
"telemetry": {
  "sessionIdHeaderHosts": ["*"]                          // Восстановить поведение рассылки R1
  "sessionIdHeaderHosts": []                              // Полностью отключить header
  "sessionIdHeaderHosts": ["api.mycompany.com",
                           "*.gateway.mycompany.internal"]
}
```

Значение по умолчанию (из `packages/core/src/telemetry/trusted-llm-hosts.ts:DEFAULT_SESSION_ID_HEADER_HOSTS`):

```
dashscope.aliyuncs.com
dashscope-intl.aliyuncs.com
*.dashscope.aliyuncs.com
*.dashscope-intl.aliyuncs.com
*.alibaba-inc.com
*.aliyun-inc.com
```

Семантика этого набора: "LLM provider, backend ARMS Tracing, одна юридическая единица distribution nessy-cli" — то есть соответствие отношения single-vendor / single-direction claude-code в nessy-cli. Third-party provider (OpenAI / Anthropic / OpenRouter / и др.) по умолчанию **не** получают header.

### 11.3 Синтаксис Pattern (намеренно крошечный)

`matchesTrustedHost(hostname, patterns)` поддерживает только два режима, выровнено с `DashScopeOpenAICompatibleProvider.isDashScopeProvider`:

- bare hostname → точное сопоставление (case-insensitive)
- `*.suffix` → сопоставление с самим `suffix` **И** любым поддоменом; dot-anchored отвергает векторы атак typo-suffix типа `evil-alibaba-inc.com` / `alibaba-inc.com.attacker.tld`

Не вводим regex, не вводим globbing с осознанием порта/scheme — пусть строка в settings будет именно тем, что она означает буквально.

### 11.4 Отличия реализации от R1

#### `wrapFetchWithCorrelation` (OpenAI / Anthropic)

Wrapper R1 имел только два gate: telemetry-enabled + sessionId. R3 вставляет третий gate между ними:

```ts
const trustedHosts =
  config.getTelemetrySessionIdHeaderHosts?.() ??
  DEFAULT_SESSION_ID_HEADER_HOSTS;
const broadcastAll = trustedHosts.some((p) => p.trim() === '*');

return async function correlationFetch(input, init) {
  if (!config.getTelemetryEnabled()) return baseFetch(input, init);
  if (!broadcastAll) {
    const host = extractRequestHost(input);
    if (!host || !matchesTrustedHost(host, trustedHosts)) {
      return baseFetch(input, init); // host gate
    }
  }
  const sid = config.getSessionId();
  if (!sid) return baseFetch(input, init);
  // ... injection header
};
```

`trustedHosts` snapshot один раз при wrap (в отличие от "чтения в реальном времени per-request" session id). Изменение `telemetry.sessionIdHeaderHosts` в середине процесса требует пересоздания contentGenerator для вступления в силу. Запись типа `[" * "]` с пробелами через `.trim()` fallback в broadcast, избегая молчаливой деградации от опечатки в settings.json.

#### `staticCorrelationHeaders` (Gemini)

Сигнатура добавляет параметр `destinationUrl?: string`:

```ts
export function staticCorrelationHeaders(
  config: Config,
  destinationUrl?: string,
): Record<string, string> {
  if (!config.getTelemetryEnabled()) return {};
  if (!destinationUrl) return {}; // fail-closed: не знаем назначения — не отправляем
  if (!matchesTrustedHost(new URL(destinationUrl).hostname, trustedHosts)) {
    return {};
  }
  return { [SESSION_ID_HEADER]: config.getSessionId() };
}
```

#### Интеграция в factory Gemini

SDK Gemini имеет два невидимых endpoint по умолчанию (`generativelanguage.googleapis.com` и `{region}-aiplatform.googleapis.com`, определяется через `vertexai`), factory уровень не может точно восстановить ни один из них. R3 выбирает "передавать `undefined` если `config.baseUrl` не установлен", позволяя helper fail-closed → не отправлять header. Оператор должен явно установить `baseUrl` для корреляции (тот же вход, который SDK использует для решения destination). Это изменение избегает ошибочного угадывания Vertex destination и ошибочного попадания в allowlist.

### 11.5 Новые файлы / новый код

| Файл                                                                 | Описание                                                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/core/src/telemetry/trusted-llm-hosts.ts` (НОВЫЙ)             | `DEFAULT_SESSION_ID_HEADER_HOSTS` + `matchesTrustedHost` + `extractRequestHost`                   |
| `packages/core/src/telemetry/trusted-llm-hosts.test.ts` (НОВЫЙ)        | Юнит-тест, включая векторы атак TLD-suffix, fail-closed IPv6, извлечение port/userinfo/query                          |
| `packages/core/src/telemetry/llm-correlation-fetch.ts`               | Добавлен host gate; `staticCorrelationHeaders` добавляет параметр `destinationUrl`                                 |
| `packages/core/src/telemetry/llm-correlation-fetch.test.ts`          | Добавлено 8 случаев host-gate; `mockConfig` использует `'hosts' in opts` для различения "default allowlist" vs "broadcast" |
| `packages/core/src/telemetry/config.ts` (`resolveTelemetrySettings`) | Пропуск `sessionIdHeaderHosts`                                                                       |
| `packages/core/src/config/config.ts`                                 | `TelemetrySettings.sessionIdHeaderHosts` + getter `getTelemetrySessionIdHeaderHosts()`            |
| `packages/core/src/core/geminiContentGenerator/index.ts`             | Передает `config.baseUrl` в helper; fail-closed когда undefined                                         |
| `packages/core/src/core/geminiContentGenerator/index.test.ts`        | Переписан тест Gemini telemetry-on для соответствия новой семантике fail-closed                                            |
| `packages/cli/src/config/settingsSchema.ts`                          | Entry схемы JSON `sessionIdHeaderHosts`                                                           |
| `packages/vscode-ide-companion/schemas/settings.schema.json`         | Регенерировано через `npm run generate:settings-schema`                                                    |
| `docs/developers/development/telemetry.md`                           | Переписан раздел "Session correlation header" + область действия по умолчанию + синтаксис override                                |

### 11.6 Ответы на аргументы LazzyMan

| Аргумент LazzyMan                         | Ответ R3                                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① Смещение标签 telemetry                  | **Разрешено**: в случае DashScope session id header буквально отправляется в backend ARMS Tracing (одна юридическая единица), семантика `telemetry.enabled` выровнена                                                       |
| ② Рассылка cross-vendor stable identifier | **Разрешено**: default allowlist содержит только first-party хосты Alibaba; рассылка вырождается в opt-in (`["*"]`)                                                                                                   |
| ③ traceparent — другой канал того же отпечатка    | **Временно сохранено**: traceparent по-прежнему инжектируется везде по R1. Обоснование: стандарт W3C, trace id — хэш sha256, продолжение trace внутри vendor — ключевой сценарий дизайна W3C. per-destination toggle traceparent внесен в §10 future work |

### 11.7 Известные остатки + follow-up

- **Область действия traceparent** — см. пункт ③ выше, внесено в §10
- **Per-request random UUID** (`X-Nessy-CLI-Request-Id`) — альтернативное предложение LazzyMan, внесено в §10
- **Lazy-invalidate staleness Gemini** (вариант A из §8.6) — развязано с R3, отдельный sub-issue
- **Поддержка IPv6 в `matchesTrustedHost`** — текущий IPv6 destination никогда не в allowlist (`URL.hostname` возвращает `[::1]` с квадратными скобками, синтаксис pattern не имеет соответствующей формы). Сейчас удовлетворяет случаю использования "именованный first-party endpoint". Если в будущем потребуется raw IP allowlist, расширим.

## 12. Ревизия R4 — Разделение Conflation Scope

> Триггер: [LaZzyMan round-8 follow-up review на PR #4390](https://github.com/NessyLM/nessy-cli/pull/4390)
> Реализация: этот PR сужен; весь код session-id из R3 перенесен в отдельный follow-up PR

### 12.1 Триггер и обоснование

R3 разрешил опасения LaZzyMan первого раунда review о «рассылке стабильного отпечатка third-party provider» (severity: high). Но в round-8 follow-up он перешел к более глубокому архитектурному принципу возражения:

> "Telemetry is not a container for adjacent features. The `traceparent` cross-process propagation and the `X-Nessy-CLI-Session-Id` header injection are **not telemetry**. They are outbound-identity / outbound-correlation work that uses some OTel APIs internally as an implementation detail."

Его основной мета-аргумент:

- **Пространство имен "telemetry" подразумевает recipient = собственный OTLP collector пользователя**
- Но получатель `traceparent` и `X-Nessy-CLI-Session-Id` = **third-party LLM provider**
- Два разных получателя должны иметь два разных дерева решений согласия
- Даже если поведение по умолчанию безопасно (R3 уже реализовано), размещение wire-level поведения под `telemetry.*` **устанавливает плохой прецедент**: будущие telemetry PR могут продолжать контрабандой проводить wire behavior к third-party
- "If we accept that principle, the split is mechanical. If we don't, this PR is the wrong place to debate it because the technical fixes are already in."

### 12.2 Обзор решения ("гибридное разделение方案 C")

После нескольких раундов внутреннего обсуждения (включая альтернативное предложение customHeader от yiliang, в конечном итоге признано, что customHeader не может нести runtime-dynamic значения), решено идти по **方案 C**:

**Этот PR оставляет**:

- Регистрация `UndiciInstrumentation` (создает client HTTP span → собственный OTLP collector пользователя)
- Guard feedback-loop OTLP (необходимый побочный эффект первого)
- **Установка `NoopTextMapPropagator` по умолчанию** → `propagation.inject()` — no-op → на outbound `fetch` **больше нет `traceparent`**
- **Новый顶级设置`outboundCorrelation.propagateTraceContext: bool` (по умолчанию false)** как независимое пространство имен; при установке true устанавливает по умолчанию... [обрезано]
- Весь код `R3 session-id` (`llm-correlation-fetch.ts` / `trusted-llm-hosts.ts` / настройка `telemetry.sessionIdHeaderHosts` / 4 точки интеграции provider / все связанные тесты) **полностью удалены**

**Перенесено в follow-up PR**:

- Весь механизм header `X-Nessy-CLI-Session-Id` (повторное использование реализации R3)
- Переход в новое пространство имен `outboundCorrelation.*` (конкретный ключ настройки TBD, но **не будет** называться `telemetry.*`)
- Follow-up PR включает: раздел threat model, независимый review, помеченные как security-relevant docs
- `X-Nessy-CLI-Request-Id` per-request UUID (альтернативный дизайн LazzyMan, предложенный в раунде R3) также входит в область рассмотрения этого follow-up

### 12.3 Сопоставление с аргументами R3 R1

| Аргумент R1/R3                                          | Статус после R4                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| §3.1 "Все исходящие LLM запросы с traceparent"              | ❌ **R4 по умолчанию off**; требуется `outboundCorrelation.propagateTraceContext: true` для включения                                       |
| §3.1 "Все исходящие LLM запросы с `X-Nessy-CLI-Session-Id`" | ❌ **R4 полностью удалено из этого PR**, перенесено в follow-up PR                                                                          |
| §4.3 инъекция session id через fetch wrapper                  | ❌ Весь код этого раздела не в этом PR; повторное использование в follow-up PR                                                                           |
| §11 host allowlist (дизайн R3)                        | ❌ То же; весь перенос в follow-up PR                                                                                      |
| §4.4 не вводит новые настройки                               | ❌ **Этот PR добавляет один boolean `outboundCorrelation.propagateTraceContext`**; настройки session id в follow-up PR |
| §10 future work "`X-Nessy-CLI-Request-Id`"          | ✅ Все еще future work; проектируется вместе с follow-up session-id                                                               |

### 12.4 Намерение дизайна нового пространства имен

顶级пространство имен `outboundCorrelation.*` в этом PR имеет только один boolean (`propagateTraceContext`), кажется чрезмерно структурированным. Но это **тщательно выбрано**:

- **Установить пространство имен как обещание**: позволить последующим session-id / request-id / etc. естественно войти в это пространство имен
- **Пометить как security-relevant**: описание `settingsSchema.ts` явно пишет "SECURITY-RELEVANT", документируется как "настройки безопасности", а не "настройки observability"
- **Все defaults отключены**: соответствует принципу LazzyMan "open-source клиент не должен без явного согласия отправлять стабильные id third-party"
- **Развязка с telemetry.\***: пользователь, читая settings.json, видит `outboundCorrelation.*` и сразу распознает, что это outbound wire behavior, а не observability

#### Скрытая зависимость: `telemetry.enabled`

Хотя пространство имен развязано с `telemetry.*`, **runtime эффективность все еще зависит от `telemetry.enabled: true`** — OTel SDK инициализируется только при включенной телеметрии, без SDK нет установки propagator, нет вызова `propagation.inject()`, флаг равен silent no-op. Легко наступить на грабли: оператор добавляет `propagateTraceContext: true`, но забывает включить telemetry, на trap server не видно никакого `traceparent`, нет ошибки / нет предупреждения.

Обе пользовательские панели явно указывают эту зависимость:

- Раздел `propagateTraceContext` в `telemetry.md` прилагает полный пример JSON с двумя флагами
- Строка описания `settingsSchema.ts` **первым предложением** указывает "Requires `telemetry.enabled: true` (前置以避免 VS Code 设置 UI 长描述折叠后看不到)

Если в будущем будут добавлены session-id header или другие настройки `outboundCorrelation.*`, **применяется та же зависимость** — все имеет смысл только при включенной телеметрии (потому что все инжектируется через OTel instrumentation/SDK). Follow-up PR должен унаследовать этот режим footgun提示.

### 12.5 Реализация

| Файл                                                                            | Изменения                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/telemetry/llm-correlation-fetch.ts`                          | **Удалено**                                                                                                                                                                                                                          |
| `packages/core/src/telemetry/llm-correlation-fetch.test.ts`                     | **Удалено**                                                                                                                                                                                                                          |
| `packages/core/src/telemetry/trusted-llm-hosts.ts`                              | **Удалено**                                                                                                                                                                                                                          |
| `packages/core/src/telemetry/trusted-llm-hosts.test.ts`                         | **Удалено**                                                                                                                                                                                                                          |
| `packages/core/src/telemetry/sdk.ts`                                            | + `NoopTextMapPropagator`; определяет textMapPropagator SDK по `getOutboundCorrelationPropagateTraceContext()`                                                                                                                          |
| `packages/core/src/core/openaiContentGenerator/provider/default.ts`             | Удалена ссылка `wrapFetchWithCorrelation`                                                                                                                                                                                              |
| `packages/core/src/core/openaiContentGenerator/provider/dashscope.ts`           | То же                                                                                                                                                                                                                              |
| `packages/core/src/core/anthropicContentGenerator/anthropicContentGenerator.ts` | То же                                                                                                                                                                                                                              |
| `packages/core/src/core/geminiContentGenerator/index.ts`                        | Удалена ссылка `staticCorrelationHeaders`                                                                                                                                                                                              |
| `*.test.ts` этих 4 provider                                               | Удалены case тестов session-id                                                                                                                                                                                                       |
| `packages/core/src/config/config.ts`                                            | Удалено `TelemetrySettings.sessionIdHeaderHosts`, `getTelemetrySessionIdHeaderHosts`; **добавлен интерфейс `OutboundCorrelationSettings` + поле `outboundCorrelationSettings` + getter `getOutboundCorrelationPropagateTraceContext()`**        |
| `packages/core/src/telemetry/config.ts`                                         | Удалена передача `sessionIdHeaderHosts` в `resolveTelemetrySettings`                                                                                                                                                                        |
| `packages/cli/src/config/settingsSchema.ts`                                     | Удалена схема `sessionIdHeaderHosts`; **добавлен顶级элемент схемы `outboundCorrelation`**                                                                                                                                                   |
| `packages/cli/src/config/config.ts`                                             | Пропуск `outboundCorrelation: settings.outboundCorrelation` в `ConfigParameters`                                                                                                                                                    |
| `packages/vscode-ide-companion/schemas/settings.schema.json`                    | Регенерировано `npm run generate:settings-schema` (описание обновляется при последующем обновлении)                                                                                                                                                     |
| `docs/developers/development/telemetry.md`                                      | Переписано "Trace context propagation" → "Client-side HTTP span on outbound fetch"; удален весь раздел "Session correlation header"; добавлен顶级раздел "Outbound correlation (SECURITY-RELEVANT)"; приложено объяснение зависимости `telemetry.enabled` + пример конфигурации JSON |
| `docs/design/telemetry-outbound-propagation-design.md`                          | Этот раздел + заголовок R4 + указатель ревизии                                                                                                                                                                                                         |
| `packages/core/src/config/config.test.ts`                                       | **Добавлен блок describe `OutboundCorrelation Configuration`**, `it.each` 4 case фиксируют безопасность default-false `getOutboundCorrelationPropagateTraceContext` (omitted / `{}` / explicit true / explicit false)                |

### 12.6 Ответ на мета-аргумент LazzyMan

| Аргумент                                            | Статус после R4                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| "Пространство имен Telemetry подразумевает собственный collector получателя" | ✅ wire behavior вынесено из `telemetry.*`; новое пространство имен `outboundCorrelation.*` явно идентифицирует семантику "outbound third-party"       |
| "Поведение по умолчанию не должно отправлять идентификаторы third-party без явного согласия"      | ✅ `propagateTraceContext` по умолчанию false; весь session-id follow-up PR также будет по умолчанию off                      |
| "telemetry PR не должен контрабандой проводить wire-level behavior"         | ✅ Этот PR больше не добавляет никаких путей кода "telemetry контролирует wire behavior"; wire behavior едино управляется `outboundCorrelation.*`管 |
| "split is mechanical, work isn't wasted"        | ✅ Код реализации R3 физически удален из этой ветки, остается в git history для повторного использования follow-up PR (или cherry-pick)          |

### 12.7 План follow-up PR (информационно, не в scope этого PR)

Будущий follow-up PR должен включать:

- Настройка `outboundCorrelation.sessionIdHeader: { enabled, trustedHosts }` или аналогичная
- Повторное использование скелета кода R3 `wrapFetchWithCorrelation` / `matchesTrustedHost` / `DEFAULT_SESSION_ID_HEADER_HOSTS`
- Раздел threat model, явно указывающий: набор получателей, окно deanonymization стабильного id,配套 опционального per-request UUID
- **По умолчанию off** (нет default allowlist — строже, чем R3, соответствует принципу open-source CLI LazzyMan)
- Пометка security-relevant + включение в `docs/users/configuration/settings.md`

