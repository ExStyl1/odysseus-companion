---
title: Проектирование декомпозиции времени выполнения запроса LLM
---

# Проектирование декомпозиции времени выполнения запроса LLM (P3 Phase 4)

> Выпуск #3731 — Phase 4 иерархической трассировки сессий. Добавляет время до первого токена (time-to-first-token), длительность подготовки запроса (request-setup duration), длительность сэмплирования (sampling duration) и телеметрию повторных попыток на каждую попытку (per-attempt retry telemetry) в спан `nessy-cli.llm_request`, чтобы операторы могли ответить на вопрос «почему этот вызов LLM был медленным?» без догадок.
>
> Основано на Phase 1 (#4126), Phase 1.5 (#4302), Phase 2 (#4321). Независимо от Phase 3 (#4410, на рассмотрении) — рекомендуется сначала выпустить Phase 3, чтобы поля агрегации на каждую попытку из Phase 4 корректно работали в поддеревьях субагентов.

## Проблема

Спаны `nessy-cli.llm_request` сегодня содержат только `model`, `prompt_id`, `input_tokens`, `output_tokens`, `success`, `error`, `duration_ms`. Операторы, читающие один трейс, не могут определить:

1. **Сколько времени из `duration_ms` ушло на размышления модели vs настройку сети.** 12 секунд `duration_ms` могут быть 11 секундами повторных попыток и 1 секундой быстрой генерации, или 100 мс настройки и 12 секундами медленной потоковой передачи — трейс не говорит об этом.
2. **Когда пользователь увидел первый токен.** TTFT (time-to-first-token) — это стандартный SLO задержки для чат-UI. Мы не можем его вычислить; мы не фиксируем его.
3. **Что происходило во время повторных попыток.** `retryWithBackoff` (`utils/retry.ts:285`) только вызывает `debugLogger.warn` — нет события OTel, нет атрибута спана. 4 места вызова LLM, которые проходят через него (`client.ts:1540`, `baseLlmClient.ts:193,282`, `geminiChat.ts:1039`), имеют нулевую видимость повторных попыток в трейсах или метриках. `ContentRetryEvent` существует для повторных попыток восстановления контента внутри `geminiChat.ts:806,830`, но не для более распространённых повторных попыток из-за ограничения скорости / 5xx ошибок.
4. **Что `api.request.breakdown` — мёртвый код.** Метрика определена в `metrics.ts:242-251` с 4 значениями `ApiRequestPhase`, экспортируется из `index.ts:117`, тестируется в `metrics.test.ts:646-675` — но у `recordApiRequestBreakdown()` нет вызовов в продакшен-коде. Инфраструктура метрики готова; поток данных никогда не был подключён.

Эти пробелы делают `nessy-cli.llm_request` наименее информативным спаном в дереве трейса. Спаны инструментов (#4126/#4321) и спаны субагентов (#4410) оба отражают фазы жизненного цикла; спаны LLM схлопывают весь запрос в одну непрозрачную длительность.

## Существующая поверхность (без изменений)

| Компонент                                                      | Расположение                                                     | Почему не трогаем                                                                                                                                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Жизненный цикл спана запроса LLM                               | `session-tracing.ts` `startLLMRequestSpan` / `endLLMRequestSpan` | Phase 1 (#4126) установил хелперы. Мы расширяем интерфейс метаданных, не реструктурируем                                                                                                                        |
|Propagation активного спана в генераторы провайдера             | `loggingContentGenerator.ts:213,287`                             | Phase 1 (#4126) заменил `withSpan('api.*')` на нативные хелперы; активный контекст уже достигает обёртки потока                                                                                                 |
| Схема `ContentRetryEvent` + потребители                        | `types.ts:626`, `nessy-logger.ts:947`, `loggers.ts:717`           | Существующее событие сохраняет свою форму и нисходящие потоки; мы добавляем родственное событие для пути `retryWithBackoff`                                                                                     |
| Лог-мост спанов `LogToSpanProcessor`                           | `log-to-span-processor.ts`                                       | Существующий мост ContentRetryEvent продолжает вкладываться в активный спан LLM. Phase 4 не меняет этого                                                                                                        |
| Enum `ApiRequestPhase`                                         | `metrics.ts:330-334`                                             | Публичная поверхность (4 значения). Мы заполняем 3 из 4 значений из продакшен-кода; оставляем enum без изменений для обратной совместимости                                                                      |
| Нормализация чанков на уровень провайдера → `GenerateContentResponse` | `loggingContentGenerator.ts:286-393`                             | Каждый провайдер уже нормализует форму `GenerateContentResponse` от Google перед тем, как LoggingContentGenerator увидит поток. Обнаружение TTFT работает централизованно над этой нормализованной формой; нет кода на каждый провайдер |
| Повторные попытки общего назначения `retryWithBackoff`         | `utils/retry.ts:140`                                             | Используется как вызовами LLM, так и не-LLM (`channels/weixin/src/api.ts`). Мы расширяем opt-in колбэком `onRetry`, а не жёстко связываем с телеметрией LLM                                                     |
| Непотоковый `generateContent`                                  | `loggingContentGenerator.ts:212`                                 | TTFT не имеет смысла для непотокового режима; новые поля остаются `undefined`. Жизненный цикл спана и существующие атрибуты без изменений                                                                       |

## Вне области (отложено)

- **Повторные попытки на уровне SDK** (openai SDK `maxRetries=3`, внутренние повторные попытки google-genai SDK). Они происходят полностью внутри стороннего SDK; наблюдение за ними требует отключения повторных попыток SDK и реализации в `retryWithBackoff`. Отдельное решение, не Phase 4.
- **Метрики потоковой передачи на каждый токен** (задержка между токенами, размер на каждый чанк). Полезно для отладки производительности inference-engine, но не для вопросов задержки, воспринимаемой пользователем, на которые нацелен Phase 4.
- **Отдельная фаза TTFT для блоков рассуждения/мышления.** «Первый токен» включает содержимое мышления (см. D1). Будущее улучшение может разделить `ttft_to_reasoning_ms` и `ttft_to_answer_ms`, но только после появления спроса.
- **Фаза сэмплирования как отдельный дочерний спан.** Вычислимо из `duration_ms - ttft_ms - request_setup_ms`; дочерний спан ничего не добавляет для бэкендов только с OTel (claude-code использует один только для Perfetto). Сохраняется как атрибут спана вместо этого — см. D6.
- **Ограничение событий на уровне повторяющихся попыток в постоянном режиме (`NESSY_CLI_UNATTENDED_RETRY`).** Один запрос LLM может породить 50+ записей `ContentRetryEvent` / `ApiRetryEvent` при постоянных повторных попытках. Ограничение выпуска событий — это последующая работа; Phase 4 выпускает все события; если объёмы продакшена окажутся невыносимыми, добавить ограничение на выпуск на спан с кратким событием «+N ещё попыток (усечено)» в последующем PR.
- **Фаза разбиения `TOKEN_PROCESSING`.** Значение enum существует, но у nessy-cli нет реальной пост-потоковой локальной обработки, которую стоило бы измерять (типично \<10 мс). Пропущено в вызовах продакшена; значение enum сохранено для будущего использования или для вызовов, которые мы не контролируем.
- **Миграция `ContentRetryEvent` на спан LLM как события спана.** Та же причина, что и у `subagent_execution` LogRecord из Phase 3: существующие потребители (nessy-logger RUM, будущие метрики) тесно связаны с LogRecord. Мост-спан достаточно хорош.

## Ссылки (доказательства решений)

| Источник                                                                                                                    | Ключевой вывод                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude-code (Anthropic) `claude.ts:1762, 1789, 1982, 2882`                                                                  | TTFT захватывается как `Date.now() - start` по событию `message_start` SSE; `start` сбрасывается на каждую попытку повторной попытки. `requestSetupMs = start - startIncludingRetries`. Массив `attemptStartTimes` сохраняется на каждую попытку. Подтверждает осуществимость подхода; их семантика TTFT — «первое событие потока» (мы отклоняемся к «первому контенту» — см. D1) |
| claude-code `perfettoTracing.ts:549-671`                                                                                    | Отображает подготовку запроса → попытка N (повторная) → первый токен → сэмплирование как вложенные пары B/E. Демонстрирует визуальную декомпозицию; nessy-cli делает ту же декомпозицию с атрибутами OTel, поскольку у нас нет Perfetto                                                                                                                |
| claude-code `sessionTracing.ts:447`                                                                                         | Только `ttft_ms` попадает в спан OTel (не `requestSetupMs`, не `samplingMs`, не время на попытку). Мы намеренно помещаем больше на спан — у claude-code есть Perfetto для визуализации; у нас его нет                                                                                                                           |
| opencode (sst/opencode) `session/llm.ts`, `route/client.ts`                                                                 | Нет измерения TTFT. Один спан Effect `LLM.run` покрывает всё. Подтверждает, что пробел существует в конкурирующих инструментах; не ссылка на то, что делать                                                                                                                                                                          |
| [OTel GenAI Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) (статус: Development / Experimental) | `gen_ai.usage.input_tokens` (Stable), `gen_ai.usage.output_tokens` (Stable), `gen_ai.usage.cached_tokens` (Experimental), `gen_ai.request.model` (Stable), `gen_ai.server.time_to_first_token` (Experimental, секунды как double). Паттерн двойного выпуска следует прецеденту #4410                                                        |
| [OTel Trace Spec — Span Events](https://opentelemetry.io/docs/specs/otel/trace/api/#add-events)                             | «События НЕ ДОЛЖНЫ использоваться для записи информации, которую лучше зафиксировать как атрибуты спана». Подтверждает, что информация на каждую попытку принадлежит атрибутам спана LLM + лог-мост спанам, а не событиям спана на родителе                                                                                                                     |
| Дизайн-док Phase 3 (`telemetry-subagent-spans-design.md`)                                                                   | Установил паттерн двойного выпуска (`nessy-cli.subagent.id` + `gen_ai.agent.id`) и правило «приватное имя является авторитетным». Phase 4 следует тому же соглашению для полей TTFT и токенов                                                                                                                                        |

## Проектирование — семь решений, каждое обосновано

### D1 — Семантика TTFT: «первый чанк, содержащий видимый пользователем контент»

TTFT измеряет настенное время от **успешной попытки** до **первого потока чанка, содержащего видимый пользователем вывод**. Чанк является «видимым пользователем», если любая нормализованная `Part` в `candidates[0].content.parts` является одной из:

- `text` с непустой строкой
- `functionCall` (использование инструмента)
- `inlineData` (изображение, бинарные данные)
- `executableCode`
- `thought` / содержимое рассуждения (что бы ни предоставлял провайдер — `thought` от Gemini, блок `<thinking>` от Anthropic, чанк рассуждения o1)

Чанки, содержащие только метаданные `role` или только `usageMetadata` (финальный чанк сводки использования), не запускают TTFT.

**Почему не «первое событие потока любого рода» (выбор claude-code)**: claude-code измеряет TTFT по `message_start`, специфичному для Anthropic событию метаданных, которое срабатывает на 50–200 мс раньше любого фактического контента. Их внутренний `headlessProfiler.ts` уже разделяет `time_to_first_response_ms` для семантики «пользователь что-то увидел», признавая различие. nessy-cli охватывает несколько провайдеров (Anthropic, OpenAI, Gemini, Nessy) — выбор семантики события метаданных означает, что TTFT для Anthropic фундаментально отличается от TTFT для OpenAI (у которого нет аналогичного первого события метаданных). Семантика видимого пользователем контента едина для всех 4 провайдеров и буквально соответствует «времени до первого токена».

**Почему включать `thought` / рассуждение**: с точки зрения оператора, чанки рассуждения всё ещё «модель создала вывод». Исключение их занизит TTFT для моделей, насыщенных рассуждениями (o1, варианты мышления Nessy). Будущее разделение на `ttft_to_reasoning_ms` и `ttft_to_answer_ms` возможно; не Phase 4.

**Почему включать чанки только с вызовами инструментов**: вызовы LLM для принятия решений агента (один `tool_use`, без текста) распространены в рабочем процессе nessy-cli. Исключение их означает, что TTFT не определён для этих запросов. Часть `functionCall` является значимым выводом.

**Заметка о сравнении между продуктами**: дизайн-док явно указывает `nessy-cli.ttft_ms ≈ claude-code.time_to_first_response_ms ≠ claude-code.ttft_ms`. Операторы, сравнивающие между продуктами, должны согласовать семантику видимого пользователем контента.

### D2 — Место измерения TTFT: локальные переменные метода в `LoggingContentGenerator.generateContentStream`

Обнаружение первого чанка работает внутри существующей обёртки потока в `loggingContentGenerator.ts:393` (`async function* processStreamGenerator`). Переменные на вызов (`start`, `ttftMs`) живут в замыкании метода; **никогда как поля экземпляра**.

**Почему никогда поля экземпляра**: `LoggingContentGenerator` инстанцируется **один раз на `ContentGenerator`** (`contentGenerator.ts:377`) и используется совместно для всех одновременных вызовов `generateContentStream` — веер субагентов, запросы прогрева, боковые запросы из `geminiChat`. Поле экземпляра было бы перезаписано между одновременными вызовами, создавая бессмысленный TTFT для одного из каждых двух переплетённых запросов.

**Почему не AsyncLocalStorage**: ALS сработал бы, но добавляет слой управления контекстом для состояния, которое не нуждается в выходе за пределы метода. Локальный метод проще, нулевые накладные расходы, нулевой риск утечки.

```ts
// loggingContentGenerator.ts — внутри generateContentStream
const attemptStart = Date.now(); // локально на вызов
const requestEntryTime = Date.now(); // также локально на вызов — см. D3
let ttftMs: number | undefined;
const attemptStartTimes: number[] = [attemptStart];
let retryTotalDelayMs = 0;
let finalAttempt = 1;
// обёртка потока проверяет каждый чанк; первый, соответствующий hasUserVisibleContent:
//   ttftMs = Date.now() - attemptStart;
```

`hasUserVisibleContent(chunk)` — небольшой автономный хелпер, расположенный рядом с обёрткой, экспортирован для тестов:

```ts
function hasUserVisibleContent(chunk: GenerateContentResponse): boolean {
  const parts = chunk.candidates?.[0]?.content?.parts;
  if (!parts?.length) return false;
  return parts.some(
    (p) =>
      (typeof p.text === 'string' && p.text.length > 0) ||
      p.functionCall !== undefined ||
      p.inlineData !== undefined ||
      p.executableCode !== undefined ||
      // @ts-expect-error — `thought` нет во всех версиях SDK, но провайдеры выпускают его
      p.thought !== undefined,
  );
}
```

### D3 — Вычисление `request_setup_ms`: время входа vs начало успешной попытки

`request_setup_ms` измеряет настенное время от входа в `generateContentStream`/`generateContent` до **начала успешной попытки** — включая все неудачные повторные попытки, задержки backoff и любую подготовительную работу до повторных попыток.

```ts
request_setup_ms = attemptStart_успешной_попытки - requestEntryTime;
```

Когда `attempt === 1` и повторных попыток не было, `request_setup_ms` мал (только настройка SDK). Когда повторные попытки произошли, он захватывает все накладные расходы бюджета повторных попыток.

**Помещение на спан OTel (отклонение от claude-code, который помещает только на Perfetto)**: обоснование на трёх уровнях:

1. **Нет Perfetto** — у nessy-cli нет стороннего слоя визуализации. Атрибуты OTel — единственный канал.
2. **Отладка одного трейса** — оператор видит `duration_ms=12000, request_setup_ms=11500, ttft_ms=200, sampling_ms=300` → мгновенно диагностирует «повторные попытки съели 11,5 с, сама модель была быстрой». Вычисление `request_setup_ms` из других полей требует также раскрытия `sampling_ms`, что мы делаем в любом случае (D6).
3. **Пренебрежимая стоимость** — 1 атрибут INT64. Тот же порядок, что и у существующих `input_tokens`, `output_tokens`. Стоимость приёма бэкендом не существенна.

### D4 — Телеметрия повторных попыток: колбэк `onRetry` для `retryWithBackoff` + `ApiRetryEvent` + распространение через AsyncLocalStorage

> **Обновление Phase 4b (пост-дизайн обнаружение)**: этот раздел изначально был написан в предположении паттерна claude-code «один спан LLM владеет циклом повторных попыток». При реализации Phase 4b мы обнаружили, что 4 места вызова `retryWithBackoff` в nessy-cli (`client.ts:2109`, `baseLlmClient.ts:235,333`, `geminiChat.ts:2035` — номера строк на момент слияния) все оборачивают `apiCall = () => contentGenerator.generateContent(...)`. Слой повторных попыток находится **над** LoggingContentGenerator. Каждая попытка повторной попытки вызывает `apiCall()` заново → новый спан `nessy-cli.llm_request`. Нет единого общего спана для всех попыток. Накопитель в `LoggingContentGenerator` не сработал бы.
>
> **Решение**: распространять состояние повторных попыток через `AsyncLocalStorage` (`retryContext` в `packages/core/src/utils/retryContext.ts`). `retryWithBackoff` оборачивает каждый `await fn()` в `retryContext.run({ attempt, requestSetupMs, retryTotalDelayMs }, fn)`. `LoggingContentGenerator` читает ALS в своём синхронном вступлении и передаёт значения в `endLLMRequestSpan`. Это на самом деле даёт **более богатую** наблюдаемость, чем первоначальный план — каждый спан на попытку имеет свои `duration_ms` / `ttft_ms` / детали ошибки И знает, где в бюджете повторных попыток он находится через атрибуты `attempt` / `requestSetupMs` / `retryTotalDelayMs` на каждую попытку.
>
> Подход ALS соответствует существующим паттернам в кодовой базе (`promptIdContext`, `subagentNameContext`, `agent-context`) — минимальная новая поверхность, хорошо понятная семантика. Процесс ревью в план-моде зафиксировал эту ревизию через 3 раунда ревью, найдя 22 замечания, все устранены до слияния.

`retryWithBackoff` в настоящее время вызывает `logRetryAttempt` (`retry.ts:343`), который только пишет в `debugLogger.warn`. Мы расширяем интерфейс `RetryOptions` opt-in колбэком:

```ts
// utils/retry.ts
interface RetryOptions<T> {
  // ... существующие поля ...
  /**
   * Опционально. Вызывается один раз на неудачную попытку, перед сном backoff.
   * Получает номер попытки (1-based), ошибку и задержку перед
   * следующей попыткой. Используйте это для выпуска телеметрических событий для мест вызова LLM;
   * оставьте undefined для не-LLM вызовов (например, channels/weixin), чтобы они
   * оставались тихими в специфичных для LLM телеметрических каналах.
   */
  onRetry?: (info: RetryAttemptInfo) => void;
}

interface RetryAttemptInfo {
  attempt: number; // 1-based, соответствует выводу debugLogger
  error: unknown;
  errorStatus?: number;
  delayMs: number; // задержка backoff перед следующей попыткой
}
```

4 места вызова LLM (`client.ts:1540`, `baseLlmClient.ts:193,282`, `geminiChat.ts:1039`) регистрируют колбэк, который выпускает новое событие `ApiRetryEvent`:

```ts
// types.ts — новый класс событий, родственник ContentRetryEvent
export class ApiRetryEvent implements BaseTelemetryEvent {
  'event.name': typeof EVENT_API_RETRY;
  'event.timestamp': string;
  model: string;
  prompt_id?: string;
  attempt_number: number; // 1-based
  error_type: string;
  error_message: string; // усечено до 256 символов
  status_code?: number;
  retry_delay_ms: number;
  // ... duration_ms установлено в retry_delay_ms, чтобы LogToSpanProcessor рендерил
  // мост-спан значимой ширины
  duration_ms: number;
}
```

**Почему новый класс событий, не расширение `ContentRetryEvent`**:

- У `ContentRetryEvent` есть 2 нисходящих потребителя (nessy-logger, экспорт log-record). Изменение его payload рискует сломать их.
- Именование «content retry» семантически относится к повторным попыткам восстановления контента (невалидный поток, ремонт схемы) — расширение для покрытия повторных попыток ограничения скорости замутило бы схему.
- Новое событие аддитивно; никакого сюрприза для потребителя.

**Почему не встроить колбэк В `retry.ts`**: `retry.ts` вызывается также `channels/weixin/src/api.ts` (повторные попытки API сообщений microsoft). Жёсткая связь телеметрии LLM внутри retry.ts выпускала бы `ApiRetryEvent` для не-LLM повторных попыток. Колбэк `onRetry` — opt-in на вызывающего — вызывающие LLM opt-in, вызывающий weixin нет.

**Сосуществование ContentRetryEvent**: ContentRetryEvent остаётся как есть для повторных попыток восстановления контента внутри `geminiChat.ts:806,830`. ApiRetryEvent покрывает повторные попытки ограничения скорости / 5xx от `retryWithBackoff`. Два события срабатывают с разных слоёв и никогда не дублируются. Существующее поведение лог-моста для обоих событий сохраняется через `LogToSpanProcessor` — оба события вкладываются в активный спан LLM автоматически (проводка Phase 1 гарантирует, что спан LLM активен во время повторных попыток).

**Режим постоянных повторных попыток (`NESSY_CLI_UNATTENDED_RETRY`)**: один запрос с циклом 429 может выпустить 50+ событий. Не в области Phase 4 ограничивать выпуск событий — если объёмы продакшена окажутся невыносимыми, добавить ограничение на спан с итоговым событием в последующем PR. Агрегированные `attempt` и `retry_total_delay_ms` на родительском спане LLM (D5) остаются точными независимо от ограничения событий.

### D5 — Агрегация родительского спана LLM: только скалярные атрибуты (без map-типов)

Атрибуты спана OTel — скаляры (`string | number | boolean | массив из них`). Атрибуты map-типа (как `retry_count_by_status: {429:2, 503:1}`) требуют JSON-сериализации и неудобны для запросов. Пропускаем их.

| Атрибут                    | Тип    | Семантика                                                                                                                                  |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `attempt`                  | int    | 1-based монотонный счётчик из `retryContext.attempt` (итерация этой попытки). Всегда заполнен (по умолчанию 1 без контекста повторных попыток) |
| `retry_total_delay_ms`     | int    | Кумулятивный сон backoff ДО начала этой попытки. Undefined для прямых вызовов; 0 для попытки 1; > 0 для последующих повторных попыток   |
| `ttft_ms`                  | int    | TTFT по D1; undefined для непотоковых или прерванных-до-первого-чанка запросов                                                          |
| `request_setup_ms`         | int    | По D3                                                                                                                                      |
| `sampling_ms`              | int    | По D6                                                                                                                                      |
| `output_tokens_per_second` | double | Производный; `output_tokens / (sampling_ms / 1000)`; undefined когда `sampling_ms === 0`                                                      |

Распределение кодов статуса на попытку (например, «2 из 3 попыток были 429») запрашивается из лог-мост спанов записей `ApiRetryEvent`. Нет необходимости дублировать это как плоский атрибут на родителе.

**Почему `sampling_ms` и `output_tokens_per_second` на спане**: выводимо, но неудобно вычислять в бэкенд-запросах при суммировании по многим спанам. Та же стоимость-выгода, что и `request_setup_ms` (D3).

### D6 — Активация `recordApiRequestBreakdown()` для 3 из 4 фаз

В `endLLMRequestSpan` (или обёртке, которая вызывает его), после вычисления TTFT/setup/sampling, выпускаем:

```ts
recordApiRequestBreakdown(config, model, [
  { phase: ApiRequestPhase.REQUEST_PREPARATION, durationMs: requestSetupMs },
  { phase: ApiRequestPhase.NETWORK_LATENCY, durationMs: ttftMs }, // ttftMs = network + first-token-generation
  { phase: ApiRequestPhase.RESPONSE_PROCESSING, durationMs: samplingMs },
]);
```

**Почему пропустить `TOKEN_PROCESSING`**: nessy-cli делает обработку чанков потока inline (консолидация происходит в обёртке на `loggingContentGenerator.ts:644`); пост-потоковая фаза свёртки \<10 мс и не архитектурно отличима. Заполнение бессмысленным значением загрязняет гистограмму. Оставить значение enum неиспользуемым безопасно — `apiRequestBreakdownHistogram.record(value, {model, phase})` это просто гистограмма с `phase` как лейблом; отсутствующие лейблы просто отсутствуют в запросах.

**Почему не переопределить `NETWORK_LATENCY`**: имя спека слегка вводит в заблуждение (это сеть + генерация первого токена, не чистая задержка сети), но:

- Enum часть `metrics.ts:330-334`, которая экспортируется из `index.ts:117` и протестирована.
- Бэкенд-дашборды могут уже ссылаться на эти имена фаз.
- Переименование или добавление новой фазы было бы breaking change для тривиально маргинального улучшения точности.

Задокументировать семантику в дизайн-доке; оставить enum без изменений.

**Почему на пути спана, не параллельно**: держит `recordApiRequestBreakdown` рядом с записями атрибутов спана — одна точка выпуска с шлюзом (см. идемпотентность D7), один инвариант порядка.

### D7 — Идемпотентность `endLLMRequestSpan`: запись метрики зашлюзована существующим guard двойного окончания

Phase 1.5 (#4302) установил, что `endLLMRequestSpan` может быть вызван дважды (столкновение пути прерывания + пути ошибки). Существующий guard на `session-tracing.ts:~470` (`if (!activeSpans.has(...)) return;`) предотвращает двойной `span.end()`. Запись метрики Phase 4 (D6) **должна находиться в том же заблокированном блоке**, перед `span.end()`:

```ts
// session-tracing.ts — endLLMRequestSpan
const llmCtx = activeSpans.get(spanRef);
if (!llmCtx) return;            // уже закончен — guard двойного окончания
activeSpans.delete(spanRef);    // забрать окончание

// ... вычислить duration, установить атрибуты ...
if (metadata) {
  recordApiRequestBreakdown(config, llmCtx.attributes.model, [...]);   // НОВОЕ — зашлюзовано
  recordTokenUsageMetrics(...); // существующее
}

span.end();
```

Это гарантирует, что метрика записана **ровно один раз** на запрос LLM, соответствуя жизненному циклу спана.

**Почему не записывать в `loggingContentGenerator`**: он не видит путь прерывания. Запись на уровне жизненного цикла спана гарантирует, что каждый запрос LLM, открывающий спан, производит ровно один образец разбиения, независимо от успеха/неудачи/прерывания.

### D8 — Двойной выпуск соглашений GenAI (приватное имя авторитетно)

Каждый атрибут Phase 4, соответствующий атрибуту semconv OTel GenAI, записывается дважды на спане:

| nessy-cli private (авторитетно)            | GenAI semconv (слой совместимости)            | Преобразование единиц | Статус спека |
| ------------------------------------------ | --------------------------------------------- | --------------------- | ------------ |
| `ttft_ms` (мс, int)                        | `gen_ai.server.time_to_first_token` (с, double) | `ttftMs / 1000`       | Experimental |
| `input_tokens` (int)                       | `gen_ai.usage.input_tokens` (int)             | идентично             | Stable       |
| `output_tokens` (int)                      | `gen_ai.usage.output_tokens` (int)            | идентично             | Stable       |
| `cached_input_tokens` (int) (при наличии)  | `gen_ai.usage.cached_tokens` (int)            | идентично             | Experimental |
| `nessy-cli.model` (string)                 | `gen_ai.request.model` (string)               | идентично             | Stable       |

**Существующие имена атрибутов токенов** на спане LLM (установлены в `endLLMRequestSpan` до Phase 4): nessy-cli уже использует голые `input_tokens` и `output_tokens`. Phase 4 добавляет родственников `gen_ai.usage.*` для соответствия паттерну #4410. Голые имена остаются; **не переименовывать**.

Поля без эквивалента GenAI semconv — `request_setup_ms`, `sampling_ms`, `retry_total_delay_ms`, `attempt`, `output_tokens_per_second` — выпускаются только под пространством имён nessy-cli.

**Почему «приватное авторитетно, semconv как совместимость»**:

- Внутренние дашборды, SLOs, вывод debugLogger, nessy-logger RUM, запросы ARMS — все ссылаются на `ttft_ms` и т.д. Рассмотрение их как канонических избегает миграции флаг-дня.
- Experimental GenAI semconv может переименовать `gen_ai.server.time_to_first_token` до достижения Stable. Если/когда это произойдёт, мы обновим выпуск semconv; имена nessy-cli не двигаются.
- Будущие бэкенды, осведомлённые о спеке (Datadog AI views, Honeycomb AI, ARMS GenAI dashboards), автоматически подхватят атрибуты `gen_ai.*` без нашего участия.

**Почему двойной выпуск преобразования единиц** (мс ↔ секунды): GenAI semconv выбрали секунды-как-double для задержки; nessy-cli выбрал мс-как-int (соответствует `duration_ms` уже на спане). Оба представления имеют ценность; преобразование дёшево.

## Helper API (аддитивно к `session-tracing.ts`)

```ts
// session-tracing.ts — интерфейс LLMRequestMetadata расширен (аддитивно)
export interface LLMRequestMetadata {
  // ... существующие поля: inputTokens, outputTokens, cachedInputTokens, success, error, ...

  /** Время от начала успешной попытки до первого чанка контента, видимого пользователем (мс). Undefined для непотоковых или прерванных-до-первого-чанка запросов. */
  ttftMs?: number;

  /** Время от входа generateContent до начала успешной попытки (мс). Включает все неудачные повторные попытки + backoff. */
  requestSetupMs?: number;

  /** Номер финальной попытки (1-based). 1 = без повторных попыток. */
  attempt?: number;

  /** Сумма всех задержек backoff перед успешной попыткой (мс). */
  retryTotalDelayMs?: number;
}

// Нет новых экспортируемых хелперов — Phase 4 переиспользует startLLMRequestSpan / endLLMRequestSpan с расширенными метаданными.
```

```ts
// types.ts — новый класс событий
export class ApiRetryEvent implements BaseTelemetryEvent {
  'event.name': typeof EVENT_API_RETRY = EVENT_API_RETRY;
  'event.timestamp': string;
  model: string;
  prompt_id?: string;
  attempt_number: number;
  error_type: string;
  error_message: string;
  status_code?: number;
  retry_delay_ms: number;
  duration_ms: number;  // = retry_delay_ms, управляет шириной мост-спана LogToSpanProcessor

  constructor(opts: { model: string; promptId?: string; attemptNumber: number; error: unknown; statusCode?: number; retryDelayMs: number }) { ... }
}

// constants.ts
export const EVENT_API_RETRY = 'nessy-cli.api_retry';

// loggers.ts
export function logApiRetry(config: Config, event: ApiRetryEvent): void { ... }
```

```ts
// utils/retry.ts — расширение RetryOptions
interface RetryOptions<T> {
  // ... существующие ...
  onRetry?: (info: RetryAttemptInfo) => void;
}

interface RetryAttemptInfo {
  attempt: number;
  error: unknown;
  errorStatus?: number;
  delayMs: number;
}

// Внутри retryWithBackoff, где сегодня вызывается logRetryAttempt:
options.onRetry?.({ attempt, error, errorStatus, delayMs: actualDelay });
logRetryAttempt(attempt, error, errorStatus); // существующий вызов debugLogger без изменений
```

## Проводка жизненного цикла

### Потоковый путь (общий случай)

```ts
// loggingContentGenerator.ts:283 — generateContentStream
async generateContentStream(req, userPromptId): Promise<AsyncGenerator<GenerateContentResponse>> {
  const requestEntryTime = Date.now();
  let attemptStart = requestEntryTime;
  const attemptStartTimes: number[] = [attemptStart];
  let retryTotalDelayMs = 0;
  let finalAttempt = 1;

  // Использовать существующий startLLMRequestSpan (Phase 1)
  // Передать колбэк onRetry любому используемому слою повторных попыток:
  const onRetry: RetryAttemptInfo & { invoke: ... } = (info) => {
    finalAttempt = info.attempt + 1;        // собираемся начать попытку N+1
    retryTotalDelayMs += info.delayMs;
    attemptStart = Date.now() + info.delayMs; // приблизительно; фактический сброс в начале следующей попытки
    attemptStartTimes.push(attemptStart);
    // выпустить ApiRetryEvent
    logApiRetry(this.config, new ApiRetryEvent({
      model: req.model,
      promptId: userPromptId,
      attemptNumber: info.attempt,
      error: info.error,
      statusCode: info.errorStatus,
      retryDelayMs: info.delayMs,
    }));
  };

  // обёртка потока обнаруживает первый видимый пользователем чанк:
  return this.processStreamGenerator(stream, ..., {
    onFirstUserVisibleChunk: (now) => {
      ttftMs = now - attemptStart;
    },
  });
}
```

В конце спана (уже в потоке Phase 1 `endLLMRequestSpan`), включить новые поля в `LLMRequestMetadata`:

```ts
endLLMRequestSpan(llmSpan, {
  success: true,
  inputTokens,
  outputTokens,
  cachedInputTokens,
  ttftMs,
  requestSetupMs: attemptStart - requestEntryTime,
  attempt: finalAttempt,
  retryTotalDelayMs,
});
```

### Непотоковый путь

`generateContent` (`loggingContentGenerator.ts:212`) не производит чанки потока. TTFT равен `undefined`; `request_setup_ms` всё ещё имеет смысл (захватывает накладные расходы повторных попыток). Метрика разбиения записывает 2 фазы (REQUEST_PREPARATION + RESPONSE_PROCESSING, где `RESPONSE_PROCESSING = duration_ms - request_setup_ms`), не 3.

### Интеграция уровня повторных попыток (4 места)

Каждое из 4 мест вызова LLM `retryWithBackoff` добавляет `onRetry`:

```ts
// client.ts:1540 (аналогично в baseLlmClient.ts:193, 282, geminiChat.ts:1039)
const result = await retryWithBackoff(apiCall, {
  ...existingOptions,
  onRetry: (info) => {
    logApiRetry(
      this.config,
      new ApiRetryEvent({
        model,
        promptId: userPromptId,
        attemptNumber: info.attempt,
        error: info.error,
        statusCode: info.errorStatus,
        retryDelayMs: info.delayMs,
      }),
    );
    // также отдавать обратно в локальный накопитель повторных попыток LoggingContentGenerator
    // (когда в области видимости — для вызывающих, которые не проходят через LoggingContentGenerator,
    // спан LLM всё ещё получает `attempt` и `retry_total_delay_ms` через путь метаданных, потому что
    // endLLMRequestSpan вызывается на уровне LLM)
  },
});
```

Вызывающий не-LLM (`channels/weixin/src/api.ts`) **не регистрирует `onRetry`** — нет выпуска `ApiRetryEvent` для его повторных попыток, что соответствует сегодняшнему поведению.

## Одновременная безопасность — главное гарантия

Экземпляр `LoggingContentGenerator` используется совместно (один на `ContentGenerator`, `contentGenerator.ts:377`). Три одновременных вызова `generateContentStream` (например, 3 субагента веером через `coreToolScheduler.runConcurrently`) выполняют три независимых замыкания `generateContentStream`:

```
call_A: attemptStart_A, ttftMs_A, ... (замыкание)
call_B: attemptStart_B, ttftMs_B, ... (замыкание)
call_C: attemptStart_C, ttftMs_C, ... (замыкание)
```

Локальные переменные на вызов никогда не перекрываются. Чанки потока обнаруживаются относительно локального `attemptStart` каждого вызова. Атрибуты спана устанавливаются в собственном `endLLMRequestSpan` каждого вызова.

`AsyncLocalStorageContextManager` (зарегистрирован NodeSDK на `sdk.ts:273`) уже гарантирует, что активный контекст OTel — и, следовательно, родительский спан, переданный в `startLLMRequestSpan` — корректен на волокно.

## Файлы для изменения

| Файл                                                                             | Изменение                                                                                                                                                                                                                                 | LOC (оценка) |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `packages/core/src/telemetry/constants.ts`                                       | Добавить константу `EVENT_API_RETRY`                                                                                                                                                                                                      | +2           |
| `packages/core/src/telemetry/types.ts`                                           | Добавить класс `ApiRetryEvent` + элемент объединения                                                                                                                                                                                      | +40          |
| `packages/core/src/telemetry/loggers.ts`                                         | Добавить функцию `logApiRetry()`                                                                                                                                                                                                          | +20          |
| `packages/core/src/telemetry/nessy-logger/nessy-logger.ts`                       | Добавить `logApiRetryEvent()` для согласованности нисходящего RUM                                                                                                                                                                         | +20          |
| `packages/core/src/telemetry/session-tracing.ts`                                 | Расширить `LLMRequestMetadata` (ttftMs, requestSetupMs, attempt, retryTotalDelayMs); расширить `endLLMRequestSpan` для установки новых атрибутов + метрика разбиения + двойной выпуск gen_ai.\*                                            | +60          |
| `packages/core/src/telemetry/metrics.ts`                                         | Подключить вызов `recordApiRequestBreakdown` внутри `endLLMRequestSpan` (без изменений в существующем рекордере)                                                                                                                          | 0            |
| `packages/core/src/utils/retry.ts`                                               | Добавить `onRetry?: (info: RetryAttemptInfo) => void` в RetryOptions; экспортировать `RetryAttemptInfo`; вызывать колбэк в существующем месте logRetryAttempt                                                                             | +25          |
| `packages/core/src/core/loggingContentGenerator/loggingContentGenerator.ts`      | Захват TTFT: локальные накопители метода + хелпер `hasUserVisibleContent` + обнаружение первого чанка в обёртке потока; передать новые метаданные в `endLLMRequestSpan`                                                                    | +80          |
| `packages/core/src/core/client.ts`                                               | Подключить колбэк `onRetry` в месте вызова `retryWithBackoff` (`client.ts:1540`)                                                                                                                                                          | +15          |
| `packages/core/src/core/baseLlmClient.ts`                                        | Подключить колбэк `onRetry` в 2 местах вызова `retryWithBackoff`                                                                                                                                                                          | +25          |
| `packages/core/src/core/geminiChat.ts`                                           | Подключить колбэк `onRetry` в месте вызова `retryWithBackoff` (`geminiChat.ts:1039`)                                                                                                                                                      | +15          |
| `packages/core/src/telemetry/session-tracing.test.ts`                            | `endLLMRequestSpan` устанавливает ttft_ms / request_setup_ms / attempt / retry_total_delay_ms / sampling_ms / output_tokens_per_second + двойной выпуск gen_ai + метрика разбиения (каждая фаза) + идемпотентное окончание                  | +120         |
| `packages/core/src/core/loggingContentGenerator/loggingContentGenerator.test.ts` | `hasUserVisibleContent` (text / functionCall / inlineData / executableCode / thought / role-only / usage-only); одновременные вызовы не перекрёстно загрязняются; TTFT undefined при прерывании до первого чанка; TTFT undefined на непотоковом | +100         |
| `packages/core/src/utils/retry.test.ts`                                          | `onRetry` вызывается на каждую неудачную попытку с корректными `attempt`, `delayMs`, `error`, `errorStatus`; отсутствие `onRetry` молчаливо (нет выпуска телеметрии)                                                                       | +50          |
| `packages/core/src/telemetry/loggers.test.ts`                                    | `logApiRetry` выпускает LogRecord с ожидаемым payload; мост через LogToSpanProcessor во вложенный спан под активным спаном LLM                                                                                                            | +40          |

Всего: 14 файлов, ~610 LOC. Больше, чем Phase 2 (#4321), но сопоставимо с Phase 3 (#4410) и оправдано широтой интеграции (4 места повторных попыток + телеметрическая проводка + обёртка потока).

Если ревью оттолкнётся от размера: разделить на **Phase 4a + 4b + 4c**:

- **4a** (~200 LOC): Захват TTFT + расширенный `LLMRequestMetadata` + двойной выпуск. Самодостаточная ценность (видимость TTFT с первого дня).
- **4b** (~250 LOC): Колбэк `onRetry` + `ApiRetryEvent` + проводка 4 вызывающих. **Самостоятельно исправление ошибки** для пробела телеметрии `retryWithBackoff`.
- **4c** (~160 LOC): Активация `recordApiRequestBreakdown` + атрибуты агрегации родительского спана (`attempt`, `retry_total_delay_ms`, `sampling_ms`, `output_tokens_per_second`). Зависит от 4a + 4b.

## Стратегия тестирования

| Тест                                                                                                                                           | Что доказывает                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `hasUserVisibleContent` возвращает true для text/functionCall/inlineData/executableCode/thought                                                | Семантика D1 по типам частей            |
| `hasUserVisibleContent` возвращает false для чанков только с role и usage                                                                      | Отрицательные случаи D1                 |
| streaming: TTFT измеряется от начала попытки до первого видимого пользователем чанка                                                           | Сквозное обнаружение TTFT               |
| streaming: TTFT undefined, если поток прерывается до любого видимого пользователем чанка                                                       | Граничный случай                        |
| streaming: TTFT вычисляется от начала финальной попытки (не первой)                                                                            | D3 — сброс TTFT при повторной попытке   |
| non-streaming: TTFT остаётся undefined                                                                                                         | Решение S3                              |
| одновременные вызовы `generateContentStream` не перекрёстно загрязняют TTFT                                                                    | Гарантия D2 — локально на метод         |
| `endLLMRequestSpan` устанавливает все атрибуты Phase 4 (ttft_ms, request_setup_ms, sampling_ms, attempt, retry_total_delay_ms, output_tokens_per_second) | Присутствие атрибутов                   |
| `endLLMRequestSpan` двойно выпускает gen_ai.server.time_to_first_token + gen_ai.usage.\* + gen_ai.request.model                                | Двойной выпуск D8                       |
| `endLLMRequestSpan` записывает метрику разбиения с 3 фазами для потокового, 2 для непотокового                                                 | D6                                      |
| `endLLMRequestSpan` вызван дважды: метрика записана ровно один раз, атрибуты не переустановлены                                                | Идемпотентность D7                      |
| `retryWithBackoff` с `onRetry`: колбэк вызывается на каждую неудачную попытку с корректными аргументами                                        | Контракт колбэка D4                     |
| `retryWithBackoff` без `onRetry`: нет выпуска телеметрии (молчаливо для не-LLM вызывающих)                                                     | Защита области P2 — channels/weixin     |
| места вызова retry в `client.ts` / `baseLlmClient.ts` / `geminiChat.ts` выпускают `ApiRetryEvent` при повторной попытке                        | Интеграция D4 в 4 местах                |
| LogRecord `ApiRetryEvent` мостится через LogToSpanProcessor к дочернему спану под активным спаном LLM                                          | Корректность дерева трейса              |
| Поле `attempt` спана LLM корректно отражает номер финальной попытки при повторных попытках                                                     | Агрегация D5                            |
| Поле `retry_total_delay_ms` спана LLM корректно суммирует задержки onRetry                                                                     | Агрегация D5                            |
| `output_tokens_per_second` undefined когда `sampling_ms === 0` (нет потокового)                                                                | Избегание деления на ноль               |

## Граничные случаи

| Случай                                                                          | Обработка                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Поток прерывается до прихода любого чанка                                       | `ttftMs = undefined`, `sampling_ms = undefined`, `output_tokens_per_second = undefined`. `attempt`, `request_setup_ms` всё ещё установлены. `success = false`                                                                    |
| Поток прерывается после первого чанка                                           | `ttftMs` установлен; `sampling_ms` = `duration_ms - ttftMs - request_setup_ms`; отражает время частичного ответа. `success = false`                                                                                             |
| Повторная попытка успешна с попытки 1 (без повторных попыток)                   | `attempt = 1`, `retry_total_delay_ms = 0`, нет выпуска `ApiRetryEvent`, метрика разбиения записывает `request_setup_ms` близко к 0                                                                                              |
| Режим постоянных повторных попыток 50+ попыток                                  | 50+ записей `ApiRetryEvent` выпущено (ограничение вне области отложено); спан LLM `attempt = 51`, `retry_total_delay_ms = сумма всех задержек`. Оператор видит агрегированный вид на спане; полные детали на попытку в лог-мост спанах |
| Вызывающий `retryWithBackoff` не-LLM (channels/weixin)                          | Нет зарегистрированного `onRetry`; срабатывает только существующий `debugLogger.warn`. Нет `ApiRetryEvent`; нет метрики разбиения (вызывающий не сайт LLM)                                                                      |
| `endLLMRequestSpan` вызван дважды (гонка прерывания + ошибки)                   | Guard Phase 1.5 на `activeSpans.delete()` возвращает рано на втором вызове; `recordApiRequestBreakdown` внутри guard, записано ровно один раз                                                                                   |
| Чанк Anthropic `message_start` приходит до контента                             | `hasUserVisibleContent` возвращает false для него (нет частей с text/functionCall и т.д.); TTFT не запущен до последующего чанка `content_block_delta`                                                                         |
| Первый чанк OpenAI с пустым `delta.content`, но только `role`                   | `hasUserVisibleContent` возвращает false; TTFT не запущен до первого чанка с непустым delta                                                                                                                                     |
| Ответ только с вызовом инструмента (без текста)                                 | Первый чанк с частью `functionCall` запускает TTFT; `output_tokens_per_second` вычислено против количества токенов вызова инструмента                                                                                            |
| Одновременные субагенты (3 вызова в полёте)                                     | Замыкание каждого вызова имеет свои `attemptStart`, `ttftMs`, `attemptStartTimes`. Спан на вызов получает свои метаданные в `endLLMRequestSpan`. Нет переплетения (D2)                                                          |
| Повторные попытки на уровне SDK внутри openai-sdk (`maxRetries=3`)              | Невидимы для телеметрии nessy-cli — происходит полностью внутри SDK до того, как retryWithBackoff увидит запрос. `attempt` отражает только попытки retryWithBackoff. Вне области (см. Вне области)                              |
| Спек `gen_ai.server.time_to_first_token` переименован до достижения Stable      | Обновление одного файла: `session-tracing.ts:endLLMRequestSpan`. Родной `ttft_ms` nessy-cli остаётся авторитетным — нет нисходящего воздействия                                                                                 |
| Запрос LLM субагента                                                            | Родитель — спан субагента (Phase 3). Поля Phase 4 вкладываются корректно. Агрегации, сгруппированные по `nessy-cli.subagent.id`, дают производительность LLM на субагент — будущее дизайн-дока, лёгкое продолжение                |
| Модель рассуждения с длинными блоками мысли                                    | Первая часть `thought` запускает TTFT; `sampling_ms` включает обе фазы мышления + ответа. Разделение на отдельные метрики отложено                                                                                             |

## Откат

Изменение аддитивно на уровне OTel и метрики — каждый новый атрибут опционален, каждое новое событие — новый класс. Существующие дашборды, которые не фильтруют по новым полям, продолжают работать без изменений.

Изменения, влияющие на поведение:

- Новый LogRecord `ApiRetryEvent` начинает течь → объём логов увеличивается пропорционально частоте повторных попыток (типично \<1% запросов повторяются). Смягчить сэмплированием LogRecord на уровне SDK, если нужно.
- Новая метрика разбиения `nessy-cli.api.request.breakdown` начинает производить временные ряды → лёгкий всплеск кардинальности Prometheus (`{model, phase}` — ограничено).
- Производный атрибут `output_tokens_per_second` может выглядеть необычно на дашбордах, фильтрующих «все атрибуты» — задокументировать.

Путь отката: отменить один PR (или каждый из 4a/4b/4c независимо). Все новые поля используют защитные значения по умолчанию (undefined / 0) и не меняют структуру спана.

## Последовательность

- **После Phase 3 (#4410, на рассмотрении)**: не жёсткая зависимость. Атрибуты Phase 4 прикрепляются к спанам `nessy-cli.llm_request` независимо от того, находятся ли они под `nessy-cli.subagent` (Phase 3) или `nessy-cli.interaction` (Phase 1) родителем. Рекомендуется сначала выпустить Phase 3, чтобы агрегация на каждую попытку под поддеревьями субагентов работала естественно.
- **Независимо от #4384** (`traceparent` + `X-Nessy-CLI-Session-Id` исходящее распространение). Они касаются HTTP-слоя; Phase 4 касается слоя потока/повторных попыток/метрики.
- **Независимо от продолжения сжатия чата `clearDetailedSpanState`** (продолжение #4097). Другая поверхность.

## Открытые вопросы

1. **Семантика срабатывания колбэка `onRetry`**: вызывается **до** сна backoff (текущее предложение) или **после** (когда следующая попытка вот-вот начнётся)? До — проще — у колбэка есть вся информация немедленно; после потребовало бы захвата только что завершённой задержки отдельно. Перед сном — рекомендация; задокументировать в контракте колбэка.
2. **Время на попытку на спане LLM**: добавить ли массив `attempt_durations_ms: number[]`? OTel поддерживает массивы примитивных атрибутов. Полезно для диагностики «какая попытка из N была медленной». Отложить до появления спроса из данных продакшена — лог-мост спаны уже носят эквивалент.
3. **Ограничение выпуска режима постоянных повторных попыток**: на каком пороге `attempt > N` начать сэмплирование? `N = 5` затем 1-из-10? `N = 10` затем только итог? Отложить до получения данных об объёме продакшена.
4. **Фаза `TOKEN_PROCESSING`**: держать значение enum спящим или подключить к чему-то (например, время консолидации)? Отложить — ждать реального варианта использования.
5. **Сводки LLM на уровне субагента**: тривиальное продолжение после выхода Phase 4 — суммировать `ttft_ms`/`output_tokens`/`input_tokens` на поддереве субагента. Не область Phase 4, но поток данных это позволяет.
