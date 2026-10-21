---
title: "Реконструкция порога автоматической компрессии"
---

# Реконструкция порога автоматической компрессии

**Статус:** Черновик · 2026-05-14

## Контекст

Текущая автоматическая компрессия в nessy-cli использует единый пропорциональный порог `COMPRESSION_TOKEN_THRESHOLD = 0.7` (`chatCompressionService.ts:33`), все размеры окна используют одну пропорцию. В сравнении с «абсолютной токеновой лестницей» claude-code (autoCompact.ts:62-65), у nessy-cli пять конкретных проблем:

1. **Избыточный резерв при большом окне:** 70% порог для 1M модели срабатывает на 700K, остаток 300K далеко превышает ~33K, нужные для summary + вывода.
2. **Одна неудача = постоянная блокировка:** `hasFailedCompressionAttempt = true` после этого вся сессия больше не пытается auto-compact (geminiChat.ts:504), строже чем «3 подряд для отсечки» в claude-code.
3. **Разрыв tip-системы и auto-порога:** три `context-*` tip в `tipRegistry.ts` используют фиксированные 50/80/95 проценты, независимо от auto-compact порога (70%). Это значит в основном пути «auto работает нормально» 80%/95% tip редко срабатывают, а в краевых путях «auto failed / reactive fallback» не хватает выровненной семантики.
4. **Нет контроля бюджета вывода при компрессии:** `packages/core/src/services/chatCompressionService.ts:374` явно включает `thinkingConfig.includeThoughts = true` (комментарий: «Compression quality drives every subsequent main turn»), при этом sideQuery вызов без `maxOutputTokens` предела. Код (`packages/core/src/services/chatCompressionService.ts:436`) признаёт `compressionOutputTokenCount may include non-persisted tokens (thoughts)`. При компрессии близко к потолку окна суммарный вывод может раздуваться, делая buffer резерв непредсказуемым.<br/><br/>Хужекросс-provider поведение различается: thinking budget Anthropic полностью независим от max_tokens; reasoning tokens OpenAI не ограничены max_completion_tokens; Gemini поведение зависит от версии модели. Это значит «просто добавить maxOutputTokens для контроля вывода» в nessy-cli с мульти-proider не работает.
5. **`lastPromptTokenCount` систематически занижен.** `packages/core/src/core/geminiChat.ts:1217` показывает число из `usageMetadata.totalTokenCount` предыдущего API response. Два разрыва: (a) не включает добавляемое в следующем раунде user message этого раунда, каждый раз cheap-gate проверка занижает значение по сравнению с реальным prompt; (b) начальное значение первого раунда 0, `--continue` восстановление огромной session / sub-agent наследование большого количества истории первый send всегда обходит все пороги. В сравнении `tokenCountWithEstimation` claude-code (`query.ts:638`) идёт по двухпутевой системе «последний assistant API usage + последующие добавленные message оценка» закрывает оба разрыва.

## Цели дизайна

- Ввести смешанный «пропорция + абсолют» порог, чтобы большие окна управлялись абсолютными значениями, малые всё ещё использовали пропорцию.
- Добавить два уровня warn / hard (auto остаётся основным триггером), формируя трёхуровневую лестницу.
- Переписать tip-систему, чтобы она следовала новым условиям срабатывания порогов.
- Обработка неудач от «1 разпостоянная блокировка」до「3 разаотсечка + автоматическое восстановление».
- **Вызов компрессии закрывает thinking и добавляет предел `maxOutputTokens`:** выравнивание с claude-code, чтобы суммарный вывод ограничивался единым параметром, budget buffer предсказуем; принимаем возможное снижение качества компрессии.
- **Добавить компенсацию оценки токенов:** устранить «отставание на раунд» и «первый раунд 0」систематические занижения `lastPromptTokenCount`, чтобы проверка порога была ближе к реальному размеру prompt.
- Удалить entry конфигурации `contextPercentageThreshold` в settings (внутренняя константа PCT сохраняется).
- **Не вводить** env покрытие, **не** добавлять явный переключатель enabled.

## Трёхуровневая лестница порогов

```
                       окно  (сырое контекстное окно)
                          │
                          │  ← SUMMARY_RESERVE = 20K
                          ▼
                    effectiveWindow
                          │
                          │  ← HARD_BUFFER = 3K
                          ▼
              hard_threshold = effectiveWindow - 3K
                          │
                          │  ← (AUTOCOMPACT_BUFFER - HARD_BUFFER) = 10K
                          ▼
auto_threshold = max(PCT * window, effectiveWindow - AUTOCOMPACT_BUFFER)
                          │
                          │  ← WARN_BUFFER = 20K
                          ▼
warn_threshold = max((PCT - WARN_OFFSET) * window, auto_threshold - WARN_BUFFER)
                          │
                          ▼
                          0
```

### Трёхуровневая семантика

| Уровень | Условие срабатывания         | Поведение                                                     |
| ------- | ---------------------------- | -------------------------------------------------------- |
| **warn** | `tokenCount >= warn_threshold` | UIподсказка「доавтоматическикомпрессияосталось X tokens」, не меняет поведение send     |
| **auto** | `tokenCount >= auto_threshold` | Перед send `tryCompress(force=false)`, нормальный процесс компрессии      |
| **hard** | `tokenCount >= hard_threshold` | Перед send `tryCompress(force=true)`, сброс блокировки неудач, принудительная компрессия |

Уровень `hard` эквивалентенпереместить логику fallback перед send, существующая reactive overflow（geminiChat.ts:711）, предотвращаяразраз неудачный oversized request round-trip.

## Внутренние константы

```ts
// chatCompressionService.ts
const DEFAULT_PCT = 0.7; // auto пропорция fallback
const WARN_PCT_OFFSET = 0.1; // warn пропорция = PCT - WARN_OFFSET = 0.6
const COMPACT_MAX_OUTPUT_TOKENS = 20_000; // жёсткий предел вывода sideQuery компрессии (thinking + summaryвсего)
const SUMMARY_RESERVE = 20_000; // выводной резерв лестницы порогов от потолка окна = maxOutput
const AUTOCOMPACT_BUFFER = 13_000; // расстояние auto от effectiveWindow
const WARN_BUFFER = 20_000; // расстояние warn от auto
const HARD_BUFFER = 3_000; // расстояние hard от effectiveWindow
const MAX_CONSECUTIVE_FAILURES = 3; // пороготсечка неудач
```

Источник чисел: всеиспользовать проверенные значения claude-code（`autoCompact.ts:30,62-65` `src/services/compact/autoCompact.ts:30`）。

`SUMMARY_RESERVE = COMPACT_MAX_OUTPUT_TOKENS` ключевое соотношение: модель ограничена жёстким `maxOutputTokens`, вывод не может превысить 20K, поэтому reserve не нуждается вдополнительный safety margin. Заметим:этот дизайн закрывает thinking послеи т.д.уравнение верно (output budgetвсё отдаётся summary);если сохранить thinking, `thinking + summary` делят бюджет (Gemini SDK /большинство provider `maxOutputTokens` семантика), модельсамостоятельновраспределяет между ними，в этом случае summary фактическое доступное пространство меньше 20K（см.「Риски и замечания」пункт 1, 2）。

## Функция вычисления

```ts
export interface CompactionThresholds {
  warn: number;
  auto: number;
  hard: number; // когда hard < auto равно auto (вырождение для малого окна)
  effectiveWindow: number;
}

export function computeThresholds(window: number): CompactionThresholds {
  const effectiveWindow = window - SUMMARY_RESERVE;

  const absAuto = effectiveWindow - AUTOCOMPACT_BUFFER;
  const auto = Math.max(DEFAULT_PCT * window, absAuto);

  const absWarn = auto - WARN_BUFFER;
  const warn = Math.max((DEFAULT_PCT - WARN_PCT_OFFSET) * window, absWarn);

  const rawHard = effectiveWindow - HARD_BUFFER;
  const hard = Math.max(rawHard, auto); // малое окноподвырождениедля auto

  return { warn, auto, hard, effectiveWindow };
}
```

### экспериментальные данные

| Окно | warn        | auto        | hard         | Примечание                            |
| ---- | ----------- | ----------- | ------------ | ------------------------------- |
| 32K  | 19.2K (pct) | 22.4K (pct) | 22.4K (вырожд) | пропорция fallback                        |
| 64K  | 38.4K (pct) | 44.8K (pct) | 44.8K (вырожд) | пропорция fallback                        |
| 128K | 76.8K (pct) | 95K (abs)   | 105K (abs)   | смешанный（warn=pct, auto/hard=abs） |
| 200K | 147K (abs)  | 167K (abs)  | 177K (abs)   | абсолютперехватить                        |
| 256K | 203K (abs)  | 223K (abs)  | 233K (abs)   | абсолютперехватить                        |
| 1M   | 947K (abs)  | 967K (abs)  | 977K (abs)   | полный абсолют                          |

`(pct)` означаетэтот уровень формулой пропорцииопределить，`(abs)` означает, что определяется формулой абсолютного значения。

## Пользовательская конфигурация

### Изменения ChatCompressionSettings

```ts
// packages/core/src/config/config.ts:217
export interface ChatCompressionSettings {
  /** Сохранено (не относится к этому дизайну, используется compactionInputSlimming） */
  imageTokenEstimate?: number;
}
```

**Удалено:** поле `contextPercentageThreshold`. Причины:

1. В новой формуле для основных окон（>= 128K）это поле почти не влияет——абсолютперехватить
2. В малых окнах пользовательская конфигурация наоборот может заставить порог「раньше」сжимать, что противоречит интуиции экономии token
3. claude-code нераскрывает это поле, нет подобного прецедента пользовательской конфигурации

### Обработка breaking change

При запуске `Config` загрузка обнаруживает `chatCompression.contextPercentageThreshold` существует:

- Записать в stderr одну строку предупреждения: `"chatCompression.contextPercentageThreshold has been removed and is now controlled by built-in thresholds."`
- **Не**ошибка, **не**блокировать запуск
- Значение поля игнорируется

## Компенсация оценки токенов

nessy-cli  `lastPromptTokenCount` из предыдущего раунда API response  `usageMetadata.totalTokenCount`（`geminiChat.ts:1217-1232` `packages/core/src/core/geminiChat.ts:1217`）。это приводит к：

1. **Отставание на раунд：** cheap-gate использование `lastPromptTokenCount` автороригинала，ноэтотраз send фактическифактический prompt = оно + текущий раунд user message。недосчитанная частьвозможнопозволитьпроверка порога false-negative
2. **Первый раунд 0：** начальное значение 0，первый раз send времянезависимо от размера историибольшойникогда не срабатывает ни один порог（включая `--continue` восстановление / sub-agent сценарий наследования）

Ввести легковесную локальную функцию оценки `estimatePromptTokens`, в send перед cheap-gate / hardавтороригиналавремя восполнить эти два пробела:

```ts
// chatCompressionService.ts（или новый файл packages/core/src/services/tokenEstimation.ts）

const BYTES_PER_TOKEN = 4; // универсальная оценка char/4（claude-code то же）
const BYTES_PER_TOKEN_JSON = 2; // JSON / tool_call input плотнее

/**
 * Оценить количество токенов набора Content,для компенсации задержки API usage metadata。
 * для image / document повторное использованиесуществующий imageTokenEstimate（по умолчанию 1600）。
 */
export function estimateContentTokens(
  contents: Content[],
  imageTokenEstimate = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): number {
  // повторное использование estimateContentChars（compactionInputSlimming.ts），затемразделить на bytesPerToken
  // ±30%константадля functionCall / functionResponse использование BYTES_PER_TOKEN_JSON
  // ...
}

/**
 * cheap-gate и hard единая точка входа проверки。
 * основной путь：lastPromptTokenCount  + текущий раунд user message оценка
 * путь первого раунда：full history оценка
 */
export function estimatePromptTokens(
  history: Content[],
  userMessage: Content,
  lastPromptTokenCount: number,
): number {
  if (lastPromptTokenCount > 0) {
    return lastPromptTokenCount + estimateContentTokens([userMessage]);
  }
  return estimateContentTokens([...history, userMessage]);
}
```

Применение позиции:

- `chatCompressionService.compress()`  cheap-gate：взять `originalTokenCount` источник заменён на `estimatePromptTokens(history, userMessage, lastPromptTokenCount)`
- `geminiChat.sendMessageStream` внедритьокно hard автороригинала（см.подразраздел）

**Оценка только дляпредлагаетсяпередсработать，не используется для пропуск срабатывания. ** потому что char/4 является грубой нижней оценкой，как false-positive сторона безопасна（лучше сжать раньше），как false-negative тогда ненадёжно

## Изменения цепочки срабатывания

### chatCompressionService.ts

1. **Экспорт `computeThresholds`**,для cheap-gate / UI / командыповторное использование
2. **`compress()` cheap-gate** (line 221-249):
   ```ts
   if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !force) {
     return NOOP;
   }
   const { auto } = computeThresholds(contextLimit);
   const effectiveTokens = estimatePromptTokens(
     curatedHistory,
     userMessage,
     originalTokenCount,
   );
   if (!force && effectiveTokens < auto) return NOOP;
   ```
3. **`compress()`  runSideQuery вызов** (line 356-380): закрыть thinking + добавить `maxOutputTokens`:

   ```ts
   const summaryResult = await runSideQuery(config, {
     // ...
     config: {
       thinkingConfig: { includeThoughts: false }, // закрыть thinking（и claude-codeсогласовано）
       maxOutputTokens: COMPACT_MAX_OUTPUT_TOKENS, // жёсткий предел 20K
     },
     // ...
   });
   ```

   или просто удалить `thinkingConfig` позволить `runSideQuery` по умолчаниюзначения（`sideQuery.ts:118` `packages/core/src/utils/sideQuery.ts:118`) по умолчанию `includeThoughts: false`）перехватить。

   закрытие thinking после，`maxOutputTokens` прямо ограничивает общий вывод（не существует thinking одиночнаянезависимый budget проблема），`SUMMARY_RESERVE = maxOutput = 20K` является чистым жёсткимзакрытиесистема。

   одновременно обновить `chatCompressionService.ts:374-376` `packages/core/src/services/chatCompressionService.ts:374` комментарий，с Compression quality drives every subsequent main turn — keep reasoning on」изменить на объяснение「дляобеспечениекросс-provider предсказуемый верхний предел вывода，и claude-code настройкаоценкадлявыравнивание

   token math сегмент（`packages/core/src/services/chatCompressionService.ts:436`） "may include non-persisted tokens (thoughts)" комментарий также можно очистить

### geminiChat.ts: `sendMessageStream` внедритьокно（line 562）

```ts
// до замены：tryCompress(force=false)
// заменапосле：использовать оценку token проверить срабатывание hard，определить force флаг

const { hard } = computeThresholds(contextLimit);
const effectiveTokens = estimatePromptTokens(
  this.getHistory(true),
  createUserContent(params.message),
  this.lastPromptTokenCount,
);
const shouldForceFromHard = effectiveTokens >= hard;

if (shouldForceFromHard) {
  // отсечкаинструмент，эквивалентно force compress
  this.consecutiveFailures = 0;
}

compressionInfo = await this.tryCompress(
  prompt_id,
  model,
  shouldForceFromHard,
  params.config?.abortSignal,
);
```

### Модернизация обработки неудач (`geminiChat.ts:504-510`)

```ts
// до замены
hasFailedCompressionAttempt: boolean;

// заменапосле
consecutiveFailures: number;  // по умолчанию 0

// ветка неудачи
} else if (isCompressionFailureStatus(info.compressionStatus)) {
  if (!force) {
    this.consecutiveFailures += 1;
  }
}

// ветка успеха
this.consecutiveFailures = 0;
```

`force=true` неудачный вызов не засчитывается（сохранить существующий reactive / manual навсегда"квоту"семантика）。

## Изменения UI

### tipRegistry.ts переписать три context-\* tip

Три уровня порога точно соответствуют трём tip. Отношениеотображение（по token числоскачестводостижениевысокий）:

| Tip ID             | Текущее условие                                      | Новое условие                                                              | Изменение текста                                                          |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `compress-intro`   | `pct >= 50 && < 80 && sessionPromptCount > 5` | `tokenCount >= warn && tokenCount < auto && sessionPromptCount > 5` | без изменений                                                          |
| `context-high`     | `pct >= 80 && < 95`                           | `tokenCount >= auto && tokenCount < hard`                           | без изменений                                                          |
| `context-critical` | `pct >= 95`                                   | `tokenCount >= hard`                                                | добавить фразу「Auto-compact will force on next send.」отражает новое поведение уровня hard |

**длявлияние на частоту срабатывания：**

- основной путь（auto нормальная работа）：`tokenCount` пересечение auto послесразу после срабатываниякомпрессия，следующий раунд tokenCount возврат，поэтому `context-high` только в「между срабатыванием и вступлением компрессии в силу」кратковременноэтотсм.
- краевой путь（auto после / отсечка / reactive не успевает）：`tokenCount` продолжает расти，последовательно проходит через warn → auto → hard срабатывают три tip，соответствует пользовательскому взгляду на"контекст становится всё теснее"согласовано
- `context-critical` при срабатывании hard уровень уже в send перед force compress（раздел spec об изменениях цепочки срабатывания），поэтомуэта tip фактически является「post-rescue информирование」а не「pre-rescue предупреждение」，добавить пояснение в текст

`TipContext` окноувеличить:

```ts
export interface TipContext {
  lastPromptTokenCount: number;
  contextWindowSize: number;
  sessionPromptCount: number;
  sessionCount: number;
  platform: string;
  // добавлено：позволить isRelevant функция может получить пороги。
  // computeThresholds ввызоввычисления в вызывающейпослекомментарийвнедрить，избежать tipRegistry прямая зависимость core。
  thresholds?: CompactionThresholds;
}
```

`AppContainer.tsx:1150` конструирование `TipContext` синхронное внедрение при。

### /context командысинхронно (`contextCommand.ts:177-183`)

```ts
// заменить жёсткое кодирование (1 - threshold) * contextWindowSize
const { warn, auto, hard, effectiveWindow } =
  computeThresholds(contextWindowSize);

// показать четыре строки：
//   Effective window:   180K   (window − 20K reserve)
//   Warn threshold:     147K   (...)
//   Auto threshold:     167K   ← когдапередпозиция
//   Hard threshold:     177K
// отметить текущееперед token count в какой попадает tier
```

### Footer непрерывная подсказка（этотвыбранный follow-up）

этот spec не требует реализации footer непрерывная подсказка，причина：

- существующий tip система уже может в history дать подсказку в
- Footer непрерывная подсказкатребует изменения ink рендеринг、увеличитьчастоту перерисовки
- этоткакэтот spec после follow-up（независимый PR）

состоянияпоследелать впоследствии，предлагаетсяусловие срабатывания `tokenCount >= warn && tokenCount < auto`，превысить auto послескрыть（компрессия началась）。

## Покрытие тестами

### Модульные тесты（chatCompressionService.test.ts）

- `computeThresholds(32K)` → ветка пропорционального fallback（warn/auto оба pct，hard вырождение）
- `computeThresholds(128K)` → смешанная ветка（warn=pct，auto=abs，hard=abs）
- `computeThresholds(200K)` → абсолютное управлениесоответственноподдержка（warn/auto/hard оба abs）
- `computeThresholds(1M)` → полностью абсолютнаядлясоответственноподдержка
- `computeThresholds(window=10K)` → очень малое окно（абсолютнаядлязначения полностью отрицательны），формула не ломается
- три уровня порогов всегда удовлетворяют `warn <= auto <= hard`
- max() формула в граничных точках（pct \* window == abs）стабильна

### Модульные тесты（tokenEstimation.test.ts）

- `estimateContentTokens` длячистого текстаэтот / json / functionCall / functionResponse / image / document соответственно проходятдлядолжен bytesPerToken
- `estimatePromptTokens` в `lastPromptTokenCount > 0` время прохождения「основной путь」，равно 0 время прохождения「путь первого раунда」
- большой user message в cheap-gate этапбытьдобавитьна путиудалитьпослеможетпересечение auto после срабатываниязначения
- оценкаиреальный API usage отклонение в ±30% в пределах（использованиереальныйисторических выборокэтотреальных）

### Интеграционные тесты（geminiChat.test.ts / chatCompressionService.test.ts）

- 3 последовательных неудачпосле cheap-gate NOOP；следующий раз force послевосстановление
- одиночная неудача больше непостоянная блокировка
- оценка token пересечение hard после send автоматически force compress
- компрессия sideQuery вызов `maxOutputTokens = COMPACT_MAX_OUTPUT_TOKENS` правильно передаётся в `runSideQuery`，`thinkingConfig.includeThoughts` для `false`（или sideQuery по умолчаниюзначенияперехватить）
- **покрытие первого раунда**：конструированиераз `lastPromptTokenCount = 0` но history огромныйбольшой chat（симуляция `--continue` восстановление），первый раз send время auto порог может бытьоценкапутьсработать

### Тесты совместимости

- настройка `contextPercentageThreshold = 0.5` запуск → stderr предупреждение + поле игнорируется，поведениедляв пределахконстанта PCT константыдля

### Тесты системы Tip（tipRegistry.test.ts）

- три context-\* tip впересечение warn/auto/hard времяправильное срабатывание，и интервал не
- основной путьпод auto срабатывание порогакомпрессияпосле `context-high` непродолжаетэтотсм.
- краевой путь（отсечка + token продолжает расти）подтри tip последовательное срабатывание
- TipContext отсутствует `thresholds` время（fallback）поведениедля

## Поэтапная реализация

| Phase | содержимое                                                                                         | независимыйность             |
| ----- | -------------------------------------------------------------------------------------------- | ------------------ |
| 1     | внутренние константы + `computeThresholds` + cheap-gate изменения（навсегдавключаяоценкакомпенсация）                             | этотнезависимыйи         |
| 2     | обработка неудач обновлена（1 → 3 отсечка）                                                                   | этотнезависимыйи         |
| 3     | hard уровень force compress предлагаетсяперед                                                                  | зависимость P1 + P7       |
| 4     | изменение конфигурации + breaking change предупреждение                                                            | зависимость P1            |
| 5     | UI（tip переписать + /context）                                                                    | зависимость P1            |
| 6     | компрессия sideQuery закрытие thinking + добавить `maxOutputTokens` верхний предел                                       | независимыйэтотсначалапредсказуемый P1 реализация |
| 7     | Token оценкакомпенсация（`estimateContentTokens` + `estimatePromptTokens`，применить к cheap-gate / hard） | независимыйэтоти P1 параллельно   |

каждый Phase этотнезависимый PR。предлагаетсяпорядок объединения **P6 → P7 → P1 → P2 → P4 → P3 → P5**：сначала добавитькомпрессиявызовдобавитьна пути `maxOutputTokens` верхний предел（позволить buffer предположение достоверно）；затемдобавитьоценкакомпенсация（позволить token суждение о числе более надёжно）；затеминфраструктура пороговреализация；затем сделатьпослеотсечка、изменение конфигурации；приоритетнеепослеоткрыть hard уровень активной спасательной операции（этотвремяуже есть надёжный token число + отсечкаинструмент）。каждый PR всеможетнезависимыйпроверить、независимыйреальныхоткат.

## Риски и замечания

1. **Закрытие thinking может повлиять на качество резюме.** Автор оригиналакомментарий "Compression quality drives every subsequent main turn — keep reasoning on" обеспокоенностьвыразилавтордлякомментарийобеспокоенность。этот spec суждение「предсказуемый token верхний предел」приоритетнее「приоритетнеебольшойизменениеесли」，нореализацияпосленужно наблюдать telemetry в `compression_input_token_count` / `compression_output_token_count` распределение，распределениеа такжедлядиалог вкомпрессияпослеизменение качества（отзывы пользователей、`COMPRESSION_FAILED_*` коэффициент состояния）。если качествоподснижениеухудшится，затем рассмотреть возврат к thinking включить + provider-specific thinkingBudget контроль。

2. **`maxOutputTokens` достижение предела может привести к summary быть обрезанным.** закрытие thinking после，20K прямое ограничение summary основная часть；claude-codeэкспериментальные p99.99 ≈ 17K，оставить ~3K резерв безопасности。но nessy-cli компрессия prompt и claude-code различный，распределение нужно наблюдать。предлагаетсявкомпрессияветка неудачи（`chatCompressionService.ts:464-491` `packages/core/src/services/chatCompressionService.ts:464`）добавитьдобавить「обнаружено finish_reason = MAX_TOKENS」 NOOP путь，избежатьпостоянное хранениеполовина summary。

3. **кросс-provider  maxOutputTokens различия в отображении.** OpenAI compat (dashscope) → `max_tokens`、Anthropic → `max_tokens`、Gemini SDK → `maxOutputTokens`。когдаперед nessy-cli уже есть это отображение（`contentGenerator.ts:94` `packages/core/src/core/contentGenerator.ts:94` и т.д.），нужнов P6 фактическитекущийвремяпроверить sideQuery путьна пути `maxOutputTokens` поле действительно проходит через все provider тело запроса。

4. **Token оценкакомментарийгрубыйподграница，не следует использовать в обратном направлении как"пропуск срабатывания"основание.** `char/4` икаждый provider реальный tokenizer отклонениевозможно ±30%。этот spec толькоиспользовать оценкуприйти「позволитьпорог сработает раньше」（false-positive направление，лучше рано сжать, чем поздно）。все「снизить token оценкачисло / пропуститькомпрессия」кодпутьвсё ещё должен использовать `lastPromptTokenCount`（API авторитетное значение）。

5. **Оценочная функция и существующая `estimateContentChars`.** `compactionInputSlimming.ts` `packages/core/src/services/compactionInputSlimming.ts` уже есть `estimateContentChars`（используется длякомпрессия split point вычисление），добавлено `estimateContentTokens` долженповторное использованиеоно（разделить на bytesPerToken）а неписать новый набор，избежатьдвумя наборамиоценкарасхождений в методике。

## Не входит в сферу этого spec

- Канал покрытия переменных Env（план D）：поддерживать「минимальная конфигурация」принцип
- Визуализацияпостоянный Footer：оставитьоригинала follow-up
- Улучшение prompt резюме，настройка `MIN_COMPRESSION_FRACTION`：идизайну порогов ортогонально

## Открытые вопросы（и т.д.ожидание review）

1. **Интенсивность breaking change：** предупреждение + игнорировать поле vs запускошибка。когдапередвыбранныйпредупреждение，нужно подтвердитьдлякорпоративного развёртывания/достаточно ли дружелюбна конфигурация команды
2. **малое окно（32K）под hard и auto вырождениедляодно значение：** нужно ли с пользовательской точки зренияв `/context` явно указать「в этом окнепод hard ужевырождение」
