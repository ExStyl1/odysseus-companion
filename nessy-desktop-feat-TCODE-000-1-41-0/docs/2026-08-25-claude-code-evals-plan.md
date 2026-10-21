# Evals для Claude Code в nessy-desktop: ресерч и план интеграции

Дата: 2026-08-25. Статус: предложение (ресерч + план, не активный план в смысле
`docs/superpowers/plans/` — трекера нет намеренно).

**Scope (подтверждён):** оцениваем работу Claude Code как агента над репозиторием
nessy-desktop — качество выполнения дев-задач, следование AGENTS.md, регрессии при
изменении CLAUDE.md/AGENTS.md, скиллов, промптов и конфигурации агента. Продуктовые
evals самого агента Nessy и evals импортируемых плагинов — вне scope первой очереди
(для них в конце есть отдельная секция).

---

## TL;DR

Готового «одного правильного» решения нет: GitHub-топик `claude-code-evals` пуст,
высокотрекшн OSS-харнесса именно под Claude Code не существует. Практика на август
2026 — три рабочих пути, и они комбинируются:

| Путь | Что это | Зрелость | Рекомендация |
| --- | --- | --- | --- |
| **promptfoo** + провайдер `anthropic:claude-agent-sdk` | Готовый eval-раннер (Node/TS, MIT): агент гоняется на реальном checkout, все tool-calls попадают в `metadata.toolCalls`, грейдеры — детерминированные, trajectory и LLM-rubric; GitLab CI + JUnit из коробки | Зрелый, ~20k звёзд, активный | **Основной харнесс. Начать здесь.** |
| Свой харнесс на `@anthropic-ai/claude-agent-sdk` / `claude -p --output-format json` | Полный контроль: SDK уже в dependencies проекта (0.3.223), хуки, structured outputs, стоимость в ответе | Стабильные примитивы, но раннер/отчёты/CI пишем сами | Fallback / точечные кастомные проверки |
| **Harbor** (Terminal-Bench 2.0, Apache-2.0) | SWE-bench-подобные изолированные задачи в Docker на *своём* репо: `task.toml` + `instruction.md` + Dockerfile + `tests/test.sh` → reward; Claude Code — предынтегрированный агент; pass@k, параллель | Активный, рекомендован в eval-гайде Anthropic | Тяжёлый tier — этап 2, когда лёгкий харнесс упрётся |
| `claude plugin eval` (нативный) | Anthropic-овский харнесс: кейсы `evals/<case>/prompt.md` + грейдеры (regex, tool_used, tool_order, file_exists, llm-judge), ablation with/without, JSON-отчёт | **Early access** — включается на организацию; в публичных доках ещё нет | Взять для evals импортируемых плагинов/скиллов, когда откроют доступ |

Методология — по Anthropic «Demystifying evals for AI agents» (янв 2026): 20–50
кейсов из реальных фейлов; детерминированные тесты для исходов + LLM-rubric для
транскриптов; грейдить результат, а не путь; pass@k против шума; изолированные
окружения. Braintrust / LangSmith / Evalite / DeepEval — обзор в §2, в первую
очередь они не нужны.

---

## 1. Что именно оцениваем

Четыре вопроса, на которые eval-suite должен отвечать воспроизводимо:

1. **Исход задачи.** Агент получил типовую задачу (добавить i18n-ключ, починить
   известный баг, вставить строку в трекер плана) — прошли ли после него реальные
   гейты репо: `typecheck`, `bun test`, `lint:i18n:parity`, `ipc:inventory:check`,
   `sort-plan-tracker.py --check`? Это самые дешёвые и надёжные грейдеры — они
   уже написаны и живут в `package.json`.
2. **Соблюдение контракта AGENTS.md.** Не трогал `.references/`; использовал
   CodeGraph до grep/чтений; не оставил `Co-Authored-By`; scope ограничен фазой;
   ветка/коммит по конвенции. Частично проверяется детерминированно (diff по
   запретным путям, trajectory-ассерты по tool-calls), частично — LLM-rubric по
   транскрипту.
3. **Регрессии конфигурации.** Изменили AGENTS.md / скилл / промпт — стало лучше
   или хуже? Это A/B: та же матрица кейсов на двух ревизиях конфигурации,
   сравнение pass@k и стоимости.
4. **Экономика.** Стоимость и число turns на кейс (в JSON-выводе headless-режима
   и SDK есть `total_cost_usd`, `num_turns`) — чтобы «стало лучше» не означало
   «стало втрое дороже».

## 2. Ландшафт: что было проверено и отброшено

Проверено по живым докам/реестрам 2026-08-25 (ссылки в §9).

**promptfoo** — единственный зрелый инструмент с целевым провайдером под Claude
Code: `anthropic:claude-agent-sdk` (алиас `anthropic:claude-code`). Ключевые опции
провайдера: `working_dir` (реальный checkout; без него — temp-dir без
инструментов), `permission_mode` (`acceptEdits` / `dontAsk` / `bypassPermissions`
/ …), `append_allowed_tools` / `custom_allowed_tools` / `disallowed_tools`,
`max_budget_usd`, `mcp.servers`, `skills`, `plugins`, `setting_sources`
(подхватывать ли `.claude/` проекта). Каждый tool-call доступен ассертам через
`response.metadata.toolCalls` (`name`, `input`, `output`, `is_error`), скиллы — в
`metadata.skillCalls`. Ассерты: детерминированные (`regex`, `contains`,
`is-json`, latency/cost), агентные (`trajectory:tool-used`,
`trajectory:tool-args-match`, `trajectory:tool-sequence`, `trajectory:step-count`,
`skill-used`), кастомный код (JS/Python, `file://`), model-graded (`llm-rubric`,
`g-eval`, pairwise `select-best`). GitLab CI задокументирован (JUnit XML →
нативный test-viewer GitLab). MIT, ядро бесплатно.

**Harbor / Terminal-Bench 2.0** — харнесс для изолированных end-to-end задач:
задача = каталог с `task.toml`, `instruction.md`, `environment/` (Dockerfile —
туда кладётся ваш монорепо + Bun), `tests/test.sh`, пишущий `reward.json`, плюс
эталонный `solution/`. `harbor run --agent claude-code --model …` из коробки,
масштабирование локально/в облаке, pass@k. Python-CLI, но сами задачи — Docker и
shell, так что TS-фиту не мешает. Anthropic в своём eval-гайде называет Harbor
рекомендованным инструментом.

**Свой харнесс на Agent SDK / headless CLI** — примитивы стабильны:
`claude -p "<задача>" --output-format json --max-turns N --max-budget-usd X
--allowedTools "Read,Edit,Bash" --permission-mode dontAsk` возвращает JSON с
`result`, `total_cost_usd`, `usage`, `session_id`; `--output-format stream-json`
даёт поток событий с tool-calls; `--json-schema` — structured output для
самоотчёта агента. В TS SDK то же самое программно (`query()`, хуки
`PreToolUse`/`PostToolUse`/`Stop`, `maxBudgetUsd`). Это ровно то, что promptfoo
делает под капотом — писать самим имеет смысл только для проверок, которые в
promptfoo не выражаются.

**`claude plugin eval`** — нативный харнесс Anthropic: кейсы
`evals/<case>/prompt.md` (frontmatter: `runs`, `max_turns`, `allowed_tools`,
`model`, …) + грейдеры-файлы (`type: regex | tool_used | tool_order |
file_exists | llm | baseline`), ablation `--ablation with-without`, моки MCP,
JSON-отчёт со стабильной схемой, `--threshold` и exit-коды под CI. Сейчас —
early access по организациям (без включения команда печатает «currently in early
access» и выходит с кодом 1), в публичных доках отсутствует. Держать на радаре;
для nessy особенно релевантен как готовый ablation-харнесс для импортируемых
плагинов и скиллов.

**Отброшено для первой очереди:** Braintrust (отличный TS `Eval()` +
турникейный трейсинг Claude Agent SDK и регресс-диффы экспериментов, но SaaS —
данные транскриптов уезжают наружу, для T-Bank-контура это отдельное решение;
Pro $249/мес); LangSmith (то же по сути; их MIT-библиотека `agentevals` с
trajectory-матчерами может пригодиться отдельно); DeepEval TS-порт (0.9.x,
слишком молодой); Evalite (хороший локальный TS/Vitest-раннер, но нет
trajectory-хелперов — проигрывает promptfoo по готовому функционалу); SWE-bench
собственные инстансы (пайплайн создания официально «на паузе», Python-центричен;
их новый SWE-smith — исследовательский пайплайн, дорогой сетап); aider-benchmark
(только фиксированные Exercism-наборы); OpenAI Evals (не про агентов на репо).
Из мелких проектов заслуживают взгляда идеями, не зависимостью: Caliper (pass@k
для скиллов Claude Code с базлайном «без скилла») и agent-skills-eval (A/B
скиллов с судьёй).

## 3. Целевая архитектура

```
nessy-desktop/
├── evals/
│   ├── promptfooconfig.yaml        # матрица: провайдер(ы) × кейсы × ассерты
│   ├── cases/                      # 1 файл = 1 кейс (промпт + переменные)
│   │   ├── i18n-add-key.yaml
│   │   ├── plan-tracker-insert.yaml
│   │   ├── fix-known-bug-<TCODE>.yaml
│   │   └── ...
│   ├── graders/
│   │   ├── repo-gates.js           # запускает реальные гейты в worktree кейса
│   │   ├── scope-guard.js          # diff не трогает запретные пути
│   │   └── rubrics/agents-md.md    # рубрика LLM-судьи по AGENTS.md
│   └── README.md                   # как добавлять кейсы; методология
├── scripts/evals/
│   ├── prepare-workspaces.ts       # git worktree на кейс от зафиксированного SHA
│   └── compare-runs.ts             # diff двух прогонов (A/B AGENTS.md)
└── .gitlab-ci.yml                  # job `evals` (manual + nightly schedule)
```

Три уровня грейдинга на каждый кейс, от дешёвого к дорогому:

1. **Детерминированный (обязателен, хотя бы один):** реальные команды репо в
   worktree кейса + проверка diff. Это ансамбль «tests pass» из Anthropic-гайда —
   грейдим исход, а не путь.
2. **Trajectory (по необходимости):** `trajectory:tool-used` и порядок —
   например, `codegraph_explore` был вызван раньше первого `Grep`/`Read`
   исходников (контракт из AGENTS.md §CodeGraph).
3. **LLM-rubric (умеренно):** судья — *другая* модель, не та, что выполняла
   задачу; голосование 2-из-3 при флаках; рубрики короткие и проверяемые
   («изменения ограничены заявленным scope: да/нет + цитата»).

Изоляция — принципиальна и специфична для nessy: в AGENTS.md зафиксировано, что
два конкурентных `bun test` в одном checkout фабрикуют фейлы (module-scope env
mutation). Поэтому **каждому кейсу — свой `git worktree`** от зафиксированного
SHA, грейдеры бегут внутри worktree кейса, а конкурентность promptfoo либо 1,
либо равна числу независимых worktree. Плюс `rm -rf release` перед `bun test` и
известный register известно-падающих тестов (`docs/superpowers/specs/
2026-07-29-known-failing-tests.md`) — грейдер должен сверяться с ним, чтобы не
записать агенту чужой фейл.

## 4. План интеграции по этапам

### Этап 0 — предпосылки (полдня, без кода)

Решить два вопроса, которые блокируют всё остальное:

- **Доступ к API из CI.** promptfoo-провайдер и headless `claude -p` ходят в
  Anthropic Messages API: нужен `ANTHROPIC_API_KEY` в GitLab CI variables
  (protected — учитывая, что на feature-ветках protected-секреты отсутствуют,
  eval-job вешается на protected ref или на schedule) **или**
  `ANTHROPIC_BASE_URL` на внутренний шлюз, говорящий Anthropic Messages.
  Внимание: продуктовый loopback-адаптер `claude-runtime` (Anthropic Messages →
  Nestor gateway) живёт внутри приложения per-session — для CI его в текущем
  виде нет; если ключа не будет, вынос этого транслятора в маленький standalone
  прокси — отдельная задача-предпосылка.
- **Бюджет.** Порядок величины: кейс ≈ $0.2–1.0 за прогон агента + центы за
  судью; 15 кейсов × 3 прогона (pass@3) ≈ $10–45 за полный прогон. Ставим
  `max_budget_usd` на кейс и договариваемся о частоте (nightly + вручную перед
  merge изменений AGENTS.md/скиллов, не на каждый MR).

### Этап 1 — golden set: 10–15 кейсов из реальной истории (1–2 дня)

Не выдумывать задачи — источники уже в репо: закрытые планы
`docs/superpowers/plans/` (задача = промпт, итоговый коммит = референс),
`measured-traps` (каждая ловушка — готовый негативный кейс: «агент должен НЕ
попасться»), паритет-аудит. Стартовый набор, где грейдеры уже написаны в
`package.json`:

| Кейс | Промпт (суть) | Детерминированный грейдер |
| --- | --- | --- |
| `i18n-add-key` | Добавить строку UI c ключом X | `bun run lint:i18n:parity && bun run lint:i18n:sorted` + ключ есть во всех локалях |
| `plan-tracker-insert` | Добавить строку в трекер плана | `python3 scripts/sort-plan-tracker.py --check` + строка в sorted-позиции, не append |
| `ipc-change` | Добавить/поменять IPC-хендлер | `bun run ipc:inventory:check` + typecheck затронутого пакета |
| `fix-known-bug-*` | 2–3 реальных пофикшенных бага (промпт = исходный тикет) | целевой тест красный до / зелёный после, `typecheck:shared` |
| `scope-discipline` | Задача с соблазном выйти за scope | diff не трогает `.references/`, `fastlane/`, `.gitlab-ci.yml`, `policy.yml` |
| `release-notes` | Закрытие плана: bump версии | версии в root и electron `package.json` в lockstep + новый файл release-notes |
| `codegraph-first` | Любая исследовательская задача | trajectory: `codegraph_explore` раньше первого `Grep` по исходникам |

Каждому кейсу — карточка: промпт, стартовый SHA, allowed tools, бюджет, список
грейдеров, ожидание (pass-критерий словами). По Anthropic-гайду цель — вырасти
до 20–50 кейсов, пополняя из реальных фейлов агента («фейл в проде → кейс в
suite» — та же дисциплина, что owner-правило «findings become plan rows»).

### Этап 2 — харнесс на promptfoo (2–3 дня)

```bash
bun add -d promptfoo   # или npx promptfoo@latest — раннеру Bun не мешает
```

`evals/promptfooconfig.yaml` (скелет):

```yaml
description: nessy-desktop agent evals
providers:
  - id: anthropic:claude-agent-sdk
    config:
      working_dir: '{{workdir}}'            # worktree кейса, готовит prepare-workspaces.ts
      permission_mode: acceptEdits
      append_allowed_tools: ['Write', 'Edit', 'Bash']
      setting_sources: ['project']          # подхватить .claude/ и AGENTS.md проекта
      max_budget_usd: 1.0

defaultTest:
  options:
    # судья — другая модель, не исполнитель
    provider: anthropic:messages:claude-sonnet-latest

tests:
  - description: i18n-add-key
    vars:
      workdir: .evals-workspace/i18n-add-key
    prompt: file://cases/i18n-add-key.prompt.md
    assert:
      - type: javascript
        value: file://graders/repo-gates.js   # exec гейтов в vars.workdir
      - type: javascript
        value: file://graders/scope-guard.js
      - type: llm-rubric
        value: file://graders/rubrics/agents-md.md
```

`graders/repo-gates.js` (суть):

```js
const { execSync } = require('node:child_process');
module.exports = (output, { vars }) => {
  const run = (cmd) => execSync(cmd, { cwd: vars.workdir, stdio: 'pipe' });
  try {
    run('bun run lint:i18n:parity');
    run('bun run lint:i18n:sorted');
    return { pass: true, score: 1, reason: 'repo gates green' };
  } catch (e) {
    return { pass: false, score: 0, reason: String(e.stdout || e) };
  }
};
```

`scripts/evals/prepare-workspaces.ts`: на каждый кейс `git worktree add
.evals-workspace/<case> <pinned-sha>` + `bun install --frozen-lockfile` (worktree
делит `.git`, но `node_modules` свой — это и есть изоляция от трапа с
конкурентными `bun test`). После прогона — `git worktree remove --force`.

Локальный запуск: `npx promptfoo eval -c evals/promptfooconfig.yaml`,
просмотр — `npx promptfoo view`. Повторы для pass@k: `--repeat 3`.

### Этап 3 — GitLab CI (1 день)

Job в `.gitlab-ci.yml`: `when: manual` + nightly schedule; артефакты — JUnit XML
(`--output junit.xml` у promptfoo задокументирован для GitLab test-viewer) и
JSON-результаты; переменные `ANTHROPIC_API_KEY` (protected) и порог
`--fail-on-error` / собственный threshold-скрипт по JSON. Job не блокирует MR —
он информационный, кроме одного случая: MR, меняющий `AGENTS.md`, `.claude/`,
скиллы или промпты, обязан приложить прогон (примерно как сейчас гейт-команды в
Verification Budget).

### Этап 4 — A/B и регрессионная дисциплина (после стабилизации suite)

Изменение AGENTS.md/скилла → два прогона от одного SHA (baseline-конфиг vs
новый), `scripts/evals/compare-runs.ts` сравнивает по кейсам pass@k, стоимость,
turns. Правило принятия: изменение конфигурации агента принимается, если pass@k
не упал ни на одном кейсе и средняя стоимость не выросла > X%. Учесть шум: по
Anthropic «Quantifying infrastructure noise» одиночный прогон недоказателен —
минимум 3 повтора на арм, решение по разнице агрегатов, не по одному кейсу.

### Этап 5 — опционально, по мере необходимости

- **Harbor-tier** для тяжёлых end-to-end задач (сборка, packaged-поведение —
  всё, что по AGENTS.md требует «packaged build evidence»): Docker-окружение с
  монорепо и Bun, verifier = реальные гейты, `harbor run --agent claude-code`.
- **`claude plugin eval`** — запросить early access; когда откроют, перенести на
  него ablation-evals импортируемых Claude Code / Codex плагинов и скиллов
  (готовые `--ablation with-without`, моки MCP, HTML-отчёт).
- Каталогизация транскриптов фейлов (promptfoo хранит их в результатах) →
  пополнение golden set.

## 5. Метрики

На кейс: pass@k и pass^k (k=3), стоимость $, turns, число tool-calls, нарушения
scope (шт.), rubric-score. На suite: общий pass-rate, суммарная стоимость
прогона, дельта к предыдущему прогону. Всё это либо уже в выводе provider'а
(`total_cost_usd`, `metadata.toolCalls`), либо считается грейдерами.

## 6. Риски и ловушки

**Недетерминизм** — главный: одиночные прогоны не сравнимы, только pass@k ≥ 3 и
агрегаты. **Судья-флак** — короткие бинарные рубрики, другая модель, 2-из-3 при
спорных. **Изоляция** — конкурентные `bun test` в одном checkout (трап из
AGENTS.md), phantom-фейлы от packaged tree (`rm -rf release`), известно-падающие
тесты из register не в счёт агенту. **Стоимость** — `max_budget_usd` на кейс,
nightly вместо per-MR. **Оверфит на suite** — если агент(промпт) «выучил» кейсы,
suite перестаёт мерить; лечится ротацией и пополнением из свежих фейлов.
**Секреты** — транскрипты содержат содержимое файлов репо; результаты хранить
как CI-артефакты с ограниченным доступом, внешние SaaS (Braintrust/LangSmith) —
только после отдельного решения по контуру.

## 7. Открытые вопросы (нужно решение владельца)

1. Ключ Anthropic API в CI vs standalone-прокси на Nestor gateway — что доступно?
2. Какая модель — исполнитель в evals (та же, что у команды в Claude Code?) и
   какая — судья?
3. Блокирует ли красный eval-прогон merge изменений AGENTS.md/скиллов, или
   первое время он только информационный?
4. Запросить у Anthropic early access к `claude plugin eval` (для плагин-scope)?

## 8. Оценка трудоёмкости

Этап 0 — 0.5 дня (решения + секреты). Этап 1 — 1–2 дня (golden set). Этап 2 —
2–3 дня (харнесс + грейдеры + worktree-изоляция). Этап 3 — 1 день (CI). Итого
**~1 рабочая неделя до работающего nightly-прогона**; этапы 4–5 — по мере
надобности.

## 9. Источники

- Anthropic, Demystifying evals for AI agents (2026-01):
  https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Anthropic, Quantifying infrastructure noise in agentic coding evals (2026-02):
  https://www.anthropic.com/engineering/infrastructure-noise
- promptfoo, Claude Agent SDK provider:
  https://www.promptfoo.dev/docs/providers/claude-agent-sdk/
- promptfoo, assertions / CI-CD:
  https://www.promptfoo.dev/docs/configuration/expected-outputs/ ,
  https://www.promptfoo.dev/docs/integrations/ci-cd/
- Claude Code headless mode: https://code.claude.com/docs/en/headless.md
- Claude Agent SDK (TS): https://code.claude.com/docs/en/agent-sdk/typescript.md
- Harbor / Terminal-Bench 2.0: https://github.com/laude-institute/harbor ,
  https://harborframework.com/docs/tasks
- Anthropic, develop tests (грейдеры/критерии):
  https://platform.claude.com/docs/en/test-and-evaluate/develop-tests.md
- LangChain agentevals (trajectory-матчеры, MIT):
  https://github.com/langchain-ai/agentevals
- Caliper (pass@k для скиллов Claude Code): https://github.com/edonadei/caliper
- SWE-smith (кастомные SWE-задачи из своего репо):
  https://github.com/SWE-bench/SWE-smith
- Braintrust × Claude Agent SDK:
  https://braintrust.dev/docs/integrations/agent-frameworks/claude-agent-sdk.md
- Evalite: https://evalite.dev/
- `claude plugin eval` — early access, публичной страницы нет; формат кейсов и
  грейдеров — по внутренней справке Claude Code (сверять при получении доступа).

---

# Приложение A (2026-08-26). Harbor как основное решение: deep-dive

Дополнение по вопросу «а если целиться сразу в большое и гибкое решение».
Проверено по исходникам Harbor (клон коммита `1462090f` от 2026-08-26) и живым
докам. Важно: репозиторий переехал `laude-institute/harbor` →
`github.com/harbor-framework/harbor` (старый URL редиректит).

## A.1. Вердикт

Harbor **подходит как основное решение**, и у него есть аргумент, которого нет
у promptfoo: это харнесс *много-агентный и много-модельный*. Одна и та же матрица
задач гоняется на Claude Code, Qwen (через ваш OpenAI-совместимый gateway),
Codex, «голой модели» (terminus-2) — и, что для nessy стратегически интересно, —
на **вашем собственном агенте**: кастомный адаптер (`BaseInstalledAgent`) — это
~100–600 строк Python, т.е. `nessy-general-agent` (apps/cli) можно поставить в ту
же таблицу и получить сравнение «Nessy vs Claude Code vs Qwen» на своих задачах.
Плата за это: Docker-упаковка монорепо, Python ≥ 3.12 в тулинге, более медленная
итерация по кейсу, и два инфраструктурных вопроса (A.5), которые надо закрыть до
старта. Матрица выбора — в A.6.

## A.2. Зрелость

Apache-2.0; PyPI `harbor` 0.22.0 (2026-08-22), CLI `harbor`/`hr`; ~4.6k звёзд,
очень активная разработка (коммиты ежедневно); команда Terminal-Bench
(Stanford × Laude Institute); официальный харнесс Terminal-Bench 2.x. Anthropic
рекомендует Harbor в гайде «Demystifying evals for AI agents» и цитирует
Terminal-Bench в анонсах моделей.

## A.3. Интеграция с Claude

Предынтегрированный агент `claude-code` (адаптер ~1900 строк,
`src/harbor/agents/installed/claude_code.py`):

- В контейнер задачи ставится Claude Code CLI (официальный bootstrap-инсталлер,
  fallback на npm); версия пинится: `--ak version=X.Y.Z`.
- Запуск headless: `claude --print --output-format=stream-json`, по умолчанию
  `--permission-mode=bypassPermissions` + `IS_SANDBOX=1`; транскрипт и сессии
  сохраняются в `/logs/agent/`.
- Модель: `-m anthropic/<model>` (LiteLLM-нотация). Ключи берутся с хоста и
  инжектятся per-exec (в образ не запекаются, в логах редактируются):
  `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`;
  поддержан Bedrock.
- **`ANTHROPIC_BASE_URL` форвардится** — можно указать свой шлюз, говорящий
  Anthropic Messages; адаптер при кастомном base URL пинит все алиасы моделей
  (`ANTHROPIC_DEFAULT_*_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) на заданную модель.
- Тюнинг через `--ak`: `max_turns`, `max_budget_usd`, `allowed_tools`,
  `append_system_prompt`, `permission_mode`, `config=<settings.json>`; ретраи
  только на провайдерские ошибки: `--max-retries 3 --retry-include
  ApiRateLimitError`.

```bash
export ANTHROPIC_API_KEY=...   # или ANTHROPIC_BASE_URL=https://gw.corp/anthropic
harbor run -p evals/harbor-tasks -a claude-code \
  -m anthropic/claude-opus-4-1 -k 5 -n 4 \
  --ak max_budget_usd=2 --ak version=2.1.x
```

## A.4. Интеграция с Qwen (наш кейс: Nestor gateway)

Три маршрута:

1. **Агент `qwen-coder`** (внимание: флаг именно `qwen-coder` —
   `AgentName.QWEN_CODE = "qwen-coder"`). Адаптер ставит `@qwen-code/qwen-code`
   CLI и запускает `qwen --yolo --auth-type openai --openai-api-key
   $OPENAI_API_KEY --openai-base-url $OPENAI_BASE_URL`; модель — из `-m` со
   срезанным префиксом. Т.е. против нашего gateway:

   ```bash
   OPENAI_BASE_URL=https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1 \
   OPENAI_API_KEY=<...> \
   harbor run -p evals/harbor-tasks -a qwen-coder \
     -m openai/tgpt/qwen35-397b-a17b-fp8 -k 5
   ```

2. **`terminus-2`** — референс-агент Harbor, LLM-вызовы идут через LiteLLM *на
   хосте* (ключ вообще не попадает в контейнер): `--ak
   api_base=https://.../openai-like/v1`, для нестандартных моделей — kwarg
   `model_info`. Это чистое сравнение *моделей* без вклада агентской обвязки.
3. Префикс `litellm_proxy/...` трактуется как OpenAI-совместимый эндпоинт — если
   поднимете LiteLLM-прокси перед gateway.

На лидерборде Terminal-Bench 2.0 Qwen-модели реально гоняются (Terminus 2 +
Qwen 3 Coder 480B — 23.9%, OpenHands + Qwen 3 Coder 480B — 25.4% и т.д.) — т.е.
маршрут боевой, не теоретический.

**Ловушка, специфичная для нас:** gateway аутентифицируется заголовком
`Nestor-Token: <JWT>`, а qwen CLI / LiteLLM шлют стандартный
`Authorization: Bearer`. Если gateway не принимает Bearer, нужен тонкий прокси,
переписывающий заголовок (или LiteLLM-прокси с `extra_headers` в конфиге
модели). Это тот же standalone-прокси из §7.1 основного плана — одна и та же
предпосылка закрывает и promptfoo-, и Harbor-путь, и Claude-, и Qwen-маршрут.

## A.5. Упаковка nessy-desktop и два вопроса до старта

- **Монорепо в задачу** — рекомендованный маршрут: собрать eval-образ
  *вне* Harbor (монорепо на пине SHA + `bun install --frozen-lockfile` + Bun/
  Node/Electron-зависимости), запушить в корпоративный registry и указать в
  задаче `[environment] docker_image = "registry.corp/nessy-eval:sha"` — тогда
  Harbor просто пуллит, билд-таймауты (600s по умолчанию) не мешают, токены
  clone не светятся в слоях.
- **Верификатор** — наши реальные гейты в `tests/test.sh` (typecheck, `bun
  test`, `lint:i18n:*` → `reward.json` с помощью метрик по гейтам); режим
  `[verifier] environment_mode = "separate"` + `no-network` — агент не может
  подправить тесты (важно для честных сравнений агентов).
- **Сеть** — `[agent] network_mode = "allowlist"` c `allowed_hosts =
  ["code-completion-nestor.tcsbank.ru", "api.anthropic.com",
  "registry.npmjs.org", ...]`: докeментированный сценарий «поставить агента, на
  rollout закрыть всё, кроме API».
- Вопрос 1: **где гонять.** Allowlist/no-network требуют nftables
  (`CONFIG_NFT_FIB_INET`) в ядре Docker-VM — Docker Desktop на macOS часто не
  умеет; рабочие варианты: OrbStack на маках, Linux-runner в GitLab CI (наш
  случай), или облачные бэкенды (`-e daytona|modal|e2b|...` — до 100
  параллельных trial'ов с ноутбука, но это внешние облака — для контура T-Bank
  скорее нет). GitLab CI = docker-executor на Linux — самый прямой путь.
- Вопрос 2: тот же прокси Nestor-Token из A.4.

## A.6. Harbor-first или promptfoo-first

Harbor-first оправдан, если главный вопрос — «**какой агент/модель** лучше
решает наши задачи» (Claude vs Qwen vs свой Nessy-агент; выбор дефолтной модели
gateway; RL/оптимизация дальше — у Harbor есть и это). promptfoo-first — если
главный вопрос — «**не деградировала ли конфигурация** Claude Code
(AGENTS.md/скиллы/промпты)» и нужна лёгкая итерация: там кейс = YAML +
worktree, без Docker-образов, и есть trajectory-ассерты по tool-calls, которых
в Harbor нет (Harbor грейдит исходом через test.sh + сохраняет trajectory.json
в ATIF — анализ траекторий пишется самим).

Практичный гибрид: golden set проектировать **переносимым** — промпт задачи
(`instruction.md`) и грейдер-скрипт на реальных гейтах пишутся один раз и
используются и как promptfoo-кейс (JS-грейдер зовёт тот же скрипт), и как
Harbor-задача (`tests/test.sh` зовёт его же). Тогда «начать с promptfoo, вырасти
в Harbor» не означает переписывание, а Harbor-first не блокируется на
инфраструктурных вопросах A.5.

## A.7. Источники приложения

- Репозиторий: https://github.com/harbor-framework/harbor (экс-`laude-institute/harbor`);
  агенты: `src/harbor/agents/factory.py`, `src/harbor/models/agent/name.py`;
  claude-code адаптер: `src/harbor/agents/installed/claude_code.py`;
  qwen-coder: `src/harbor/agents/installed/qwen_code.py`;
  провайдеры/env: `src/harbor/agents/model_connection.py`.
- Доки: https://www.harborframework.com/docs — tasks, agents (custom agents,
  terminus-2 `api_base`), network-policy (nftables/OrbStack caveat),
  managing-resources, cloud-sandboxes.
- PyPI: https://pypi.org/project/harbor/ (0.22.0, 2026-08-22, Python ≥3.12).
- Лидерборд с Qwen-энтри: https://www.tbench.ai/leaderboard/terminal-bench/2.0
- Кукбук (RL, рецепты задач): https://github.com/harbor-framework/harbor-cookbook

---

# Приложение B (2026-08-26). Разбор «The AI-Native SDLC Playbook» (Anthropic)

Первоисточник: https://claude.com/blog/the-ai-native-sdlc-playbook ; тот же
материал существует как курс Claude Academy
(https://academy.claude.com/courses/ai-native-sdlc-playbook, 14 уроков) —
содержание и примеры кода совпадают. Плейбук: 6 стадий (Plan → Design → Build →
Test → Deploy → Maintain), каждая — набор независимых «plays». Eval-контент —
в Stage 4 (Test) и Stage 6 (Maintain); ниже — что предлагается и как это
ложится на наш план.

## B.1. Модель эвалов по плейбуку

Play **«Continuous evals in CI»** (Stage 4) определяет evals как «AI-native
эквивалент stage-gate QA»: suite из **20–50 реальных задач из недавней работы**
с ожидаемым исходом и acceptance-чеками («tests pass, lint clean, behavior
unchanged, policy followed»). Запуск — **по расписанию (nightly) И при каждом
изменении конфигурации агента**; изменение конфигурации блокируется, если
pass-rate упал. Харнесс в плейбуке — максимально простой DIY, без фреймворков
(пример из поста, GitHub Actions, дословно):

```yaml
name: Agent evals
on:
  pull_request:
    paths: ['CLAUDE.md', '.claude/**']
  schedule:
    - cron: '0 2 * * *'
jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g @anthropic-ai/claude-code
      - name: Run eval suite
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          for eval in evals/*.json; do
            claude -p "$(jq -r '.prompt' $eval)" \
              --allowedTools "Read,Edit,Bash(make test)" \
              --output-format json > result.json
            ./evals/check.sh "$eval" result.json
          done
```

Четыре правила из урока: (1) merge гейтится порогом pass-rate; (2) каждый
продакшн-инцидент становится постоянным регрессионным кейсом; (3) suite
обновляется по мере роста моделей — переставшие различать кейсы заменяются;
(4) все результаты логируются для трендов.

Play **«Give Claude a feedback loop»** — второй слой, работающий *внутри*
задачи, а не после: у агента всегда должен быть способ проверить себя (тесты,
сборка, screenshot-diff). Конкретика: свести верификацию к единым командам с
ненулевым exit-кодом; задокументировать их в CLAUDE.md блоком «Verifying your
work» с примерами здорового вывода; для багфиксов — сначала падающий тест,
запрет правки тестов enforce'ится хуком («тест, существовавший до фикса,
который агент не мог переписать, — доказательство, что баг ушёл»). Плюс
verifier-«свежий взгляд» — отдельный сабагент, запускаемый после того, как
сессия считает работу законченной (`.claude/agents/verifier.md`: «Exercise the
changed behavior and the two nearest neighboring flows… Do not fix anything;
report only»). Метрики play: first-pass CI success rate (leading), review time
per PR и change failure rate (lagging).

Play **«Closing the loop on metrics»** (Stage 6) замыкает цикл: метрики с
control-band'ами (`bands.yaml`: 1σ → log, 2σ → diagnose, 3σ → propose PR /
runbook), а инцидент → фикс → **новый eval-кейс** («add an eval for the
incident»); повторные инциденты одной категории должны падать по мере
расширения suite. Смежный play «Hooks as approval gates» разводит роли: evals
меряют корректность, хуки enforce'ят политику (запретные пути, релизные
разрешения).

## B.2. Как это ложится на nessy

Плейбук — это ровно философия основного плана (§1–§4), в самой лёгкой
реализации. Соответствия: golden set из реальной истории = «20–50 real tasks»
(§Этап 1); детерминированные грейдеры на гейтах репо = «acceptance checks»
(`check.sh` ≈ наш `graders/repo-gates.js`); триггер на изменения
AGENTS.md/скиллов = §Этап 3; «инцидент → кейс» = наша дисциплина «фейл → кейс»
(и owner-правило «findings become plan rows» — тот же рефлекс). Уже сделанное у
нас сверх плейбука: блок «Verifying your work» в AGENTS.md фактически есть
(§Commands + Verification Budget), хуки на запретные пути — прямое продолжение
`.claude/settings`.

Минимальный DIY-вариант «как в курсе», адаптированный (если хочется начать
вообще без promptfoo — это один вечер):

```
evals/cases/i18n-add-key.json
{ "name": "i18n-add-key",
  "prompt": "Добавь в настройки строку с ключом settings.foo ...",
  "allowedTools": "Read,Edit,Write,Bash(bun run lint:i18n:parity),Bash(bun run lint:i18n:sorted)",
  "checks": ["bun run lint:i18n:parity", "bun run lint:i18n:sorted"],
  "forbiddenPaths": [".references/", "fastlane/", ".gitlab-ci.yml"] }
```

```bash
# evals/run.sh — цикл из курса + наши поправки: worktree-изоляция и бюджет
set -euo pipefail
for case in evals/cases/*.json; do
  name=$(jq -r '.name' "$case")
  wt=".evals-workspace/$name"
  git worktree add -f "$wt" "$EVAL_BASE_SHA" && (cd "$wt" && bun install --frozen-lockfile)
  (cd "$wt" && claude -p "$(jq -r '.prompt' "$case")" \
      --allowedTools "$(jq -r '.allowedTools' "$case")" \
      --max-turns 25 --max-budget-usd 1 \
      --output-format json > ../../evals/out/"$name".json) || true
  evals/check.sh "$case" "$wt"          # exit-коды гейтов + diff по forbiddenPaths
  git worktree remove --force "$wt"
done
```

Чего в курсовом харнессе нет (и почему в плане стоит promptfoo): один прогон на
кейс — при недетерминизме агента сигнал шумный (нужен pass@k ≥ 3, см.
«infrastructure noise»); нет LLM-rubric и trajectory-ассертов; нет отчётов,
трендов и JUnit для GitLab — всё это пришлось бы дописывать руками. promptfoo —
это тот же цикл из курса, где повторы, судьи, ассерты по tool-calls и отчёты уже
написаны. Т.е. «плейбук vs promptfoo» — не выбор подхода, а выбор, сколько
обвязки писать самим.

## B.3. «Или смотреть в сторону Harbor?»

Это разные слои, а не конкуренты. Continuous evals по плейбуку (≈ promptfoo,
≈ Этапы 1–4 плана) отвечают на вопрос «**не деградировала ли конфигурация
Claude Code**» — лёгкие, гоняются при каждом изменении AGENTS.md/скиллов.
Harbor (Приложение A) отвечает на «**какой агент/модель лучше** на наших
задачах» — тяжёлые изолированные сравнения (Claude vs Qwen vs свой Nessy-агент),
запускаемые редко и осознанно. Плейбук сам никакого харнесса уровня Harbor не
предлагает — его eval-урок это именно лёгкий CI-цикл. Рабочая связка: старт по
плейбуку/promptfoo (неделя, §Этап 8), golden set проектировать переносимым
(§A.6), Harbor подключать, когда встанет вопрос выбора модели/агента.

## B.4. Источники приложения

- Пост: https://claude.com/blog/the-ai-native-sdlc-playbook
- Курс (то же содержание): https://academy.claude.com/courses/ai-native-sdlc-playbook
  (уроки continuous-evals-in-ci, give-claude-a-feedback-loop,
  closing-the-loop-on-metrics, hooks-as-approval-gates)
