---
name: "architecture-analyzer"
description: "Подготовка LikeC4-диаграммы и ARCHITECTURE_SUMMARY.md по исходникам Go-сервиса."
disable-model-invocation: false
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Навык можно выбирать автоматически, когда текущая задача соответствует описанию. Загружай только нужный режим и относящиеся к нему ресурсы.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.
<!-- /odysseus-invocation-policy -->

## Odysseus: user-approved supplied skill

This skill was explicitly added by the user as an exception to the base
local/browser/Obsidian catalog. The services, local applications and MCP/CLI
integrations required by this skill are permitted for its requested workflow.
The local-only restriction of unrelated skills does not disable this exception.

Importing the skill does not connect a service, install a runtime or authorize
sending messages, publishing artifacts or changing external records by itself.
Use the host's available tools and the user's actual task authorization.
Resolve bundled scripts, assets and references from this installed skill's own
root; write task outputs in the user's working project. If a required tool,
connection or referenced resource is absent, report the exact dependency rather
than inventing a successful result.

---


# architecture-analyzer

Ты — архитектор, который документирует Go-сервис нашей команды. Стек и
layout зафиксированы. Твоя задача: пройтись по известным папкам,
классифицировать найденное по правилам глоссария, собрать LikeC4-диаграмму
и `ARCHITECTURE_SUMMARY.md` так, чтобы диаграмма получалась качественной
с первого прохода.

## Главное правило: спрашивай только то, чего нет в коде

Используй `AskUserQuestion` для информации, которую невозможно получить из
репозитория: бизнес-цели, приоритетные сценарии, аудитория документа.
Технические факты (компоненты, протоколы, владение данными) выводятся из
layout автоматически — не спрашивай их.

**НЕ выдумывай связи, которых нет в коде.** Предположения помечай
`[ПРЕДПОЛОЖЕНИЕ]` и подтверждай у пользователя.

---

## Уровни C4 — наш скоуп

Модель C4 имеет 4 уровня детализации. Метафора Google Maps: Context —
страна, Container — город, Component — улица, Code — планировка здания.

| Уровень           | Что показывает                                              | Аудитория                  | Делаем?              |
|-------------------|-------------------------------------------------------------|----------------------------|----------------------|
| **C1 Context**    | Система как чёрный ящик + актеры + внешние системы          | бизнес + техника           | ✅ всегда           |
| **C2 Container**  | Процессы / БД / очереди системы; стек технологий            | архитекторы, разработчики  | ✅ всегда           |
| **C3 Component**  | Внутреннее устройство одного контейнера: handlers, usecases | разработчики команды       | ⏸ только по запросу |
| **C4 Code**       | Классы / интерфейсы внутри компонента                       | глубокое погружение        | ❌ не делаем (IDE)  |

**Default scope этого скилла — C1 + C2.** Это покрывает 90% запросов:
«нарисуй архитектуру», «построй C4», «как устроен сервис». На этих
уровнях:

- C1 — `view context of <system>` со всеми актерами и externalSystem
- C2 — `view containers of <system>` + focused views (storage,
  incomingSync, incomingAsync, outgoing)

**C3 Components — только по явному запросу пользователя.** Триггеры:
«покажи компоненты», «components view», «уровень C3», «внутренности
kafkaConsumers», «как устроена бизнес-логика». В этом случае в spec
добавляются `handler`/`usecase`/`component` element kinds + `relationship
route`, и появляется отдельный `view components of <container>`. Подробно
— в Фазе 4, секция «C3 Components». Эталон C3 — секция «C3 Components —
паттерн» в `./references/likec4-reference.md` (упрощённый
fraud-roulette-bot с usecase-цепочкой и `relationship route`).

**C4 Code не делаем.** Если пользователь просит — порекомендуй открыть
IDE / посмотреть `REPO_MAP.md`.

---

## Команда: layout проекта (источник правды)

Опирайся на правило глоссария
(`plugins/oleg-common/skills/project-layout/references/glossary.md`):

> **repository = durable + ours. cache = rebuildable + ours. integration = theirs.**

| Папка                            | Тип сущности         | C4 элемент                  | Кто владеет |
|----------------------------------|----------------------|-----------------------------|-------------|
| `api/**/*.proto`                 | gRPC-контракт        | `service` (наш контейнер)   | мы          |
| `internal/repository/*/`         | durable storage      | `repository` (shape storage)| мы          |
| `internal/cache/*/`              | rebuildable cache    | `cache` (shape storage)     | мы          |
| `internal/integration/*/`        | внешний сервис       | `externalSystem`            | они         |
| `internal/kafka/*/`              | Kafka consumer       | `queue` внутри parent `externalSystem 'Kafka'` | мы |
| `builder.go`                     | DI wiring            | верификация связей + fallback на нестандартные интеграции | мы |
| `cmd/*/main.go`                  | процесс              | имя сервиса в диаграмме     | мы          |
| `db/migrations/` / `migrations/` | схема Postgres       | подтверждает `repository/*` | мы          |
| `helm/`, `.gitlab-ci.yml`        | деплой               | в раздел 6.7                | -           |

**Важный нюанс по Redis/Valkey:** один проект может одновременно иметь
**`internal/repository/<name>/` на Redis** (например, Redis Streams для
гарантированной доставки команд — это **durable**, ours) **и
`internal/cache/<name>.go` на Valkey** (rebuildable cache). Не объединяй
их — это два разных C4-элемента (`repository` и `cache`).

**Стек по умолчанию** (см. соседние скиллы):

- gRPC + grpc-gateway → REST (синхронные API), `protobuf-contracts`
- Postgres через sqlc + goverter + gowrap, `postgres`
- ClickHouse аналогично через sqlc/Named JdbcTemplate
- Valkey/Redis — кэши; Redis Streams — durable
- Kafka — асинхронная интеграция, `kafka-consumer`
- Внешние REST-клиенты через oapi-codegen, `http-client`
- `opt.Option[T]` вместо nil-указателей, `optional`

---

## Фаза 1: Авто-скан репозитория

1. **Сканирование** через `Glob`/`Read`/`Grep`:
   - `api/**/*.proto` — gRPC-сервисы и rpc-методы
   - `internal/repository/*/` — репозитории; по содержимому различай
     Postgres (sqlc), ClickHouse, Redis Streams
   - `internal/cache/*/` — кэши; отметь read-through декораторы поверх
     `repository/*`
   - `internal/integration/*/` — внешние системы и протокол:
     `*.proto` рядом → gRPC; `*.gen.go` от oapi-codegen → REST
   - `internal/kafka/*/` — топики; по `entity/*.go` определи схемы
   - `cmd/*/main.go` — процессы (имя сервиса)
   - `go.mod` — Go-версия, ключевые зависимости
   - `db/migrations/` или `migrations/` — подтверждение Postgres-таблиц
   - `helm/`, `docker-compose.yml`, `.gitlab-ci.yml` — для раздела 6.7
   - `README.md`, `CLAUDE.md`, `memory_bank/` — бизнес-контекст

2. **Fallback на нестандартное размещение интеграций.** Если
   `internal/integration/` пуст или отсутствует — `Grep` `builder.go` (и
   соседние wiring-файлы) на:
   - импорты `secretary-core/*`
   - вызовы `aic-go-common/grpc.NewGrpcClient`
   - oapi-codegen-клиенты, инициализируемые напрямую
   - любые конструкторы вида `NewXxxClient(...)` с network-параметрами

   Каждый такой клиент → `externalSystem`. Зафиксируй в «Открытых
   вопросах» SUMMARY: «интеграции размещены вне `internal/integration/`,
   через `secretary-core` / прямое подключение в `builder.go`».

3. **Свяжи граф** через `builder.go` и `cmd/*/main.go`: usecase →
   (repository | cache | integration | kafka). `Grep` по импортам
   подтверждает связи.

4. **Прочитай LikeC4-справочник** — `./references/likec4-reference.md`.
   Там же — полный эталонный пример (Reception Service), покрывающий
   trihead-сервис, nested Kafka, PG+Redis+Valkey, nested external,
   focused views.

5. **Покажи сводную таблицу** компонентов:

```
## Найденные компоненты

| # | Имя              | Тип          | Папка / источник              | Технология              | Владение |
|---|------------------|--------------|-------------------------------|-------------------------|----------|
| 1 | userpreferences  | repository   | internal/repository/userpref/ | Postgres + sqlc         | ours     |
| 2 | commands         | repository   | internal/repository/commands/ | Redis Streams           | ours     |
| 3 | profilescache    | cache        | internal/cache/profiles.go    | Valkey                  | ours     |
| 4 | sexic            | integration  | internal/integration/sexic/   | REST (oapi-gen)         | theirs   |
| 5 | profilesplatform | integration* | builder.go (secretary-core)   | gRPC                    | theirs   |
| 6 | order-events     | kafka        | internal/kafka/orderevents/   | Kafka + Avro            | ours     |
| 7 | api.OrderService | grpc service | api/order/v1/order.proto      | gRPC + gateway          | ours     |
```

`*` помечает нестандартное размещение интеграций (через `builder.go`).

Подтверди через `AskUserQuestion`: «Все ли компоненты найдены корректно?
Есть ли что-то вне стандартного layout?»

---

## Фаза 2: Только то, что не выводится из кода

`AskUserQuestion` (1-2 вызова, до 4 вопросов за раз):

1. **Бизнес-задача** — что делает сервис, для каких пользователей
   (внутренние/внешние), какую проблему решает?
2. **Ключевые сценарии** — какие 2-4 бизнес-флоу важно отрисовать в
   sequence-диаграммах?
3. **Целевая аудитория документа** — разработчики команды / архитектурный
   комитет / онбординг новых людей / внешний review?

### Ситуативные вопросы

- Если `integration/X` неоднозначен по протоколу (нет ни proto, ни
  openapi) — уточни «gRPC или REST?»
- Если в `repository/X` смешаны Postgres и ClickHouse — уточни границу
- Если в `builder.go` есть компонент вне layout — спроси, как
  классифицировать
- Если в `cmd/` несколько процессов — уточни, делать одну общую
  диаграмму или отдельные
- Если внутри одной внешней системы видно несколько независимых ролей-
  консьюмеров (например, два разных робота на одной платформе) —
  уточни, декомпозировать ли через nested `externalSystem`
- Если пользователь упомянул «компоненты», «components», «внутренности» —
  уточни, нужен ли C3-уровень (по умолчанию делаем только C1+C2). Если
  да — также уточни, какой контейнер показывать (`grpcApi`,
  `kafkaConsumers`, всё)

**СТОП-ПРАВИЛО:** не строй артефакты без ответов на бизнес-задачу и
сценарии.

---

## Фаза 3: Граф связей

### 3.1 Авто-классификация по layout

| Источник                  | C4 элемент                                | Стандартные связи                              |
|---------------------------|-------------------------------------------|------------------------------------------------|
| `api/*.proto` rpc methods | inbound в `service`                       | `client -> service` (grpc/rest)                |
| `internal/repository/*`   | `repository` storage                      | `service -> repo` (sql/redis)                  |
| `internal/cache/*`        | `cache` storage                           | `service -> cache` (valkey); декоратор: `cache -> repo` |
| `internal/integration/*`  | `externalSystem`                          | `service -> ext` (grpc/rest)                   |
| `secretary-core/*` или wiring в `builder.go` | `externalSystem` (с пометкой нестандартного размещения) | `service -> ext` |
| `internal/kafka/*`        | `queue` внутри `externalSystem 'Kafka'`   | `kafka.topic -> service.kafkaConsumers` (consume) |

### 3.2 Гранулярность storage — один элемент на одно физическое хранилище

Текущее правило «один `repository` на каждую `internal/repository/<name>/`»
визуально размывает то, что физически это **одна СУБД**.

**Правило:** один `repository` элемент = одно физическое хранилище.
Таблицы и пути sqlc-репозиториев перечисляются в `description`.

```likec4
pg = repository 'PostgreSQL' {
  description 'Реляционное хранилище. Таблицы: user_preferences, registered_phones, person_profile_ids. Доступ: internal/repository/{userpreferences,registeredphones,personprofileids}.'
  technology 'PostgreSQL, sqlc + goverter + gowrap'
}
```

Если в репозитории используются **разные физические системы** (Postgres
+ Redis Streams + ClickHouse) — это три отдельных `repository` элемента,
плюс отдельный `cache` для Valkey. Они **визуально различимы**, и это
важно: для читателя ясно, что данные в кэше потерять не страшно, а в
Redis Streams — страшно.

### 3.3 Kafka — без producer-стрелок, всегда в parent `externalSystem`

**Все Kafka-топики оборачивай в один родительский
`externalSystem 'Kafka'`.** Это даёт визуальный блок и отражает
реальность — Kafka это одна shared-инфраструктура, а не N независимых
систем.

```likec4
kafka = externalSystem 'Kafka' {
  description 'Шина событий.'

  topicX = queue 'topic.name' {
    description '... Consumer: internal/kafka/<name>/.'
    technology 'Kafka, JSON | Avro'
  }
}
```

**Связи только consume:** `kafka.topicX -> service.kafkaConsumers`. Имя
топика само указывает на источник — **producer→topic стрелки не
рисуем**.

**Внешние системы, существующие только как Kafka-producers** (например,
forward-сервис, mvno без других интеграций), — **не добавляй в model
вообще**. Топик и так показывает, откуда пришли данные.

### 3.4 Nested decomposition внешних систем

Если внешняя система внутри содержит несколько независимых консьюмеров
нашего API с **разными ролями** — декомпозируй через nesting:

```likec4
tivr = externalSystem 'T-IVR Bank (TWork)' {
  description 'Платформа голосовых роботов.'

  robotIvr = externalSystem 'Голосовой робот на IVR' {
    description 'Классический IVR-робот.'
  }
  robotDp = externalSystem 'Голосовой робот на DP' {
    description 'Робот на платформе DP.'
  }
}
```

Стрелки идут от конкретных роботов: `tivr.robotIvr -> reception.gateway`.

**Триггер для декомпозиции:** в коде/доках упоминаются множественные
консьюмеры одной системы с разными ролями. Если этого нет — оставляй
плоско.

### 3.5 Минимальная дедупликация

В этом стеке дубли редки. Проверь только:

- Один внешний сервис вызывается через `integration/X` и упомянут как
  proto-стаб в `api/` → одна сущность `externalSystem`
- `cache/X` обёртывает `repository/X` → отметь decorator-связь, не дубль

### 3.6 Гранулярность application-логики — схлопывай однотипные блоки

Папки в Go обычно один-в-один соответствуют файлам, но в C4-диаграмме это
почти всегда лишний шум. **Если N компонентов имеют одинаковую роль и
одинаковые исходящие/входящие связи — рисуй одним обобщённым блоком.**
Конкретные имена перечисляй в `description`, не плодя элементы.

**Триггеры схлопывания:**

- Хендлеры по состоянию чата / FSM (5 файлов в `internal/handler/*` →
  один блок `State Handler`)
- Strategies / variants одного интерфейса (4 разные реализации
  `Notifier` → один блок `Notifier`)
- Per-state / per-event UI usecase-ы, если все они дёргают одни и те же
  репозитории и messenger
- Кафка-хендлеры, у которых по одному методу-делегату на каждое событие
  одного топика — один блок `<topic> consumer` достаточно

**Когда НЕ схлопывать:**

- У компонентов разные исходящие связи (например, один из юзкейсов
  ходит в `enigma` + `s3`, остальные нет — этот выноси отдельно)
- Разные SLA / критичность / владельцы
- Пользователь явно попросил per-component breakdown

```likec4
// Плохо — 5 одинаковых хендлеров с одинаковыми связями
handlerShareContact = handler 'ShareContactHandler' { ... }
handlerAwaiting = handler 'AwaitingLetsPlayHandler' { ... }
handlerOnboarding = handler 'SaveFraudNumberHandler' { ... }
handlerMenu = handler 'FraudRouletteMenuHandler' { ... }
handlerAdvice = handler 'AdviceMenuHandler' { ... }

// Хорошо — один блок, имена в description
stateHandler = handler 'State Handler' {
  description 'Тонкий диспетчер. Один из 5: sharecontact / awaitingletsplay / onboarding / mainmenu / advicemenu — выбирается мапой state.State в builder.go.'
  technology 'internal/handler/'
}
```

Если позже кому-то понадобится per-state breakdown — это отдельный
**focused view** (например, `view stateRouting`), не разрастание модели.

---

## Фаза 4: Артефакты

`AskUserQuestion`: «Куда сохранить? По умолчанию —
`./architecture-analysis/`».

| Файл                                   | Описание                               |
|----------------------------------------|----------------------------------------|
| `{output_dir}/diagram.likec4`          | LikeC4 — Context + Container + focused |
| `{output_dir}/ARCHITECTURE_SUMMARY.md` | Архитектурный документ                 |

Перед записью убедись, что директория существует — создай при
необходимости.

---

### Артефакт 1: LikeC4-диаграмма

#### Specification block и синтаксис связей

Полный spec-block, разрешённые формы связей и **обязательное правило про
парсер** (`a -> b 'label' 'kind'` ронит dev-server) — в
`./references/likec4-reference.md`, секции «Эталонный пример — Reception
Service» и «Ключевые правила синтаксиса». Прочитай их перед генерацией.

Краткое напоминание (одно правило, которое не должно потеряться):

> Связи **только** в форме `a -> b 'label'` или `a -[kind]-> b 'label'`.
> **Никогда** `a -> b 'label' 'kind'` — третья строка валит парсер с
> `FqnRef is empty`.

#### Минималистичный spec — рекомендация

Если нет жёсткой необходимости в кастомных kind-ах, держи spec
коротким: только element-ы (actor / system / service / repository /
cache / queue / externalSystem), без declared relationships. Label на
стрелке + `technology` в блоке элемента дают всё нужное и убирают
класс ошибок с применением kind. Кастомные `relationship` объявляй
только если реально нужна визуальная разница (другой цвет/стиль линии).

#### Trihead service layout (опционально, для сервисов с gateway+gRPC+Kafka)

Текущий шаблон с одним `service api` хорошо работает для маленьких
сервисов. Для реальных сервисов с grpc-gateway + Kafka consumers лучше
**три логических `service`** внутри одной `system`:

- `gateway` — REST proxy через grpc-gateway
- `grpcApi` — бизнес-логика
- `kafkaConsumers` — async daemons

Это один процесс, но три разных способа взаимодействия. Применяй, когда
видишь все три во входах. Если только один способ — оставляй один
`service`.

#### Правила именования

- Сервис: имя из `cmd/<name>/` или из `package` в `api/*.proto`
- Repository: имя физического хранилища (`pg`, `redis`, `clickhouse`),
  **не имя папки**
- Cache: имя файла `internal/cache/<name>.go`
- Integration: имя папки `internal/integration/<name>/` или короткое имя
  системы из `secretary-core`
- Kafka: имя топика (а не папки), внутри `externalSystem 'Kafka'`

#### Views — focused breakdown

Один `view containers { include * }` даёт неуправляемую мегадиаграмму.
Заменяй на набор views:

```likec4
views {
  view context of <system> {
    title '<name> — Context (C1)'
    include *
    autoLayout TopBottom
  }

  view containers of <system> {
    title '<name> — Container (C2)'
    // Явный include — `*` иногда теряет nested storage внутри system
    include
      <system>, <system>.*,
      <все top-level externalSystem>,
      <все nested external через X.*>,
      kafka, kafka.*
    autoLayout TopBottom
  }

  view storage {
    title '<name> — Storage'
    include <system>.pg, <system>.redis, <system>.valkey,
            <system>.grpcApi, <system>.kafkaConsumers
    autoLayout LeftRight
  }

  view incomingSync {
    title '<name> — Incoming sync'
    include <sync-клиенты>, <system>.gateway, <system>.grpcApi
    autoLayout LeftRight
  }

  view incomingAsync {
    title '<name> — Incoming async (Kafka)'
    include kafka, kafka.*, <system>.kafkaConsumers,
            <system>.pg, <system>.redis
    autoLayout LeftRight
  }

  view outgoing {
    title '<name> — Outgoing sync'
    include <system>.grpcApi, <integrations...>
    autoLayout LeftRight
  }
}
```

**Правила выбора `autoLayout`:**

- **`TopBottom`** — для широких C1/C2 с большим количеством внешних
  (иначе всё растягивается в одну длинную строку)
- **`LeftRight`** — для focused views с 5-10 элементами и явным
  source→target потоком

#### C3 Components (только по запросу)

**Когда делать.** Только если пользователь явно попросил уровень
компонентов. Триггеры: «components», «компоненты», «уровень C3»,
«покажи внутренности `<container>`», «как устроена бизнес-логика».
**Не делай инициативно** — для большинства запросов хватает C1+C2.

**Когда уместно:**

- Stateful flow с роутингом по состоянию (бот / FSM)
- Много usecase'ов с переплетёнными вызовами
- Онбординг — показать структуру бизнес-логики новому разработчику

**Когда НЕ нужно:**

- CRUD-сервис handler → repository — лишний шум
- Сервис с 1-2 usecase'ами — C2 покрывает
- Пользователь не просил

**Расширение существующей диаграммы — НЕ перерисовывание.**

Прежде чем что-то писать, проверь, есть ли уже файл `diagram.likec4` в
output-директории (или в той, которую назвал пользователь). Если есть —
**не создавай новую диаграмму с нуля**. C3 — это **дельта** поверх
существующей C1/C2.

Алгоритм:

1. **`Read` существующий `diagram.likec4`.** Прочитай целиком — нужен
   полный контекст уже зафиксированных id, имён, технологий, связей.
2. **Покажи пользователю, что собираешься добавить** через
   `AskUserQuestion`:
   - какие новые element kinds (`handler`, `usecase`, `component`,
     `relationship route`) добавить в `specification`
   - в какой `service` зайти внутрь (например, `bot.kafkaConsumers`)
   - какие новые components появятся (с их именами из `internal/...`)
   - какой `view components of <container>` будет добавлен
3. **Используй `Edit`**, не `Write`:
   - в `specification` дописываешь только новые element kinds и
     `relationship route`; **не трогай** существующие
   - внутрь существующего `service` блока добавляешь новые `usecase`
     и `handler` элементы
   - в `model` добавляешь только новые `-[route]->` связи между
     добавленными usecase'ами; существующие связи (sql/kafka/grpc/rest)
     **не дублируй и не переименовывай**
   - в `views` добавляешь новый `view components of <container>` и,
     если уместно, focused view (`stateRouting` и т.п.); **существующие
     views не редактируй**
4. **Сохрани оригинальные id и имена.** Если в C2 был `bot.kafkaConsumers`
   — он остаётся `bot.kafkaConsumers` в C3, не превращается в
   `kafkaConsumers` или `bot.consumers`. Любое переименование сломает
   существующие views и ссылки.
5. **Пройди по checklist** только для новых артефактов; не пере-
   проверяй уже зафиксированные C1/C2 пункты, кроме целостности
   (вид рендерится без ошибок).

Если файла нет / пользователь хочет начать с нуля — создавай весь spec
сразу с C3-расширением (одной полной диаграммой), как описано ниже.

**Дополнения к specification:**

```likec4
specification {
  // ... всё из C1/C2 spec ...

  element handler { style { shape rectangle } }
  element usecase { style { shape rectangle } }
  element component { style { shape rectangle } }   // generic fallback

  relationship route   // вызовы методов внутри сервиса (не сетевые)
}
```

**Правила C3:**

- Заходишь **внутрь одного container** — обычно `grpcApi` или
  `kafkaConsumers`, где живёт основная бизнес-логика
- `handler` — тонкий dispatcher (`internal/handler/`)
- `usecase` — бизнес-логика (`internal/usecase/<name>/` или
  `internal/<domain>/`); имя папки идёт в `description`
- `component` — общий fallback, если не подошёл ни handler, ни usecase
- Связи между usecase'ами — `relationship route` (вызов метода, не сеть)
- БД и внешние системы остаются на C2-уровне (`repository`,
  `externalSystem`); usecase их использует, но они не дробятся
- Применяй правило 3.6 (схлопывание) — 5 одинаковых хендлеров в один
  блок, имена в `description`

**Новый view:**

```likec4
view components of <container> {
  title '<service> — Components (C3)'
  description 'Внутреннее устройство <container>: handlers и usecases.'
  include
    <container>.*,
    <соседние Kafka-топики, БД, внешние системы для контекста>
  autoLayout LeftRight
}
```

**Дополнительные focused views для C3** (опционально):

- `view stateRouting` — конкретный сценарий обработки события: kafka
  consumer → router → state handler → ui usecase → messenger

**Эталон C3:** секция «C3 Components — паттерн» в
`./references/likec4-reference.md` — упрощённый fraud-roulette-bot со
stateful Max-ботом, usecase-цепочкой router → stateHandler → uiUC →
messengerUC, схлопнутым `State Handler`, отдельным view `stateRouting`.

#### Эталонный пример

Полный аннотированный пример (Reception Service: trihead, nested Kafka,
PG+Redis+Valkey, nested T-IVR, focused views) лежит в
`./references/likec4-reference.md`. Используй его как шаблон.

#### Требования к диаграмме

- Все элементы имеют `description` и `technology`
- Все связи имеют label (`a -> b 'label'`), kind — опционально и только
  через `-[kind]->`
- Связи **не используют** третий позиционный аргумент `'kind'` —
  это валит парсер LikeC4 (`FqnRef is empty`)
- Внешние сервисы — `externalSystem` (никогда не `service`)
- `externalSystem` имеет `style { color muted }` в spec
- Все Kafka-топики обёрнуты в `externalSystem 'Kafka'`
- Producer→topic стрелки **отсутствуют**
- Postgres/Redis/Valkey — отдельные элементы, даже если код использует
  несколько repository-пакетов на одну физическую СУБД
- Однотипные application-компоненты (handlers, strategies, per-state
  usecase-ы) **схлопнуты в один обобщённый блок**, конкретные имена —
  в `description` (см. §3.6)
- Container view имеет явный `include` со списком, не `*`
- Есть focused views: storage + incomingSync + incomingAsync + outgoing
- `autoLayout`: `TopBottom` для context/containers, `LeftRight` для focused

---

### Артефакт 2: ARCHITECTURE_SUMMARY.md

**Полный шаблон документа — в `./references/summary-template.md`.**
Прочитай его перед заполнением. Шаблон покрывает 8 обязательных секций
(назначение, компоненты, цели, точки интеграции, плюсы/минусы,
технические детали, оценка и рекомендации, sequence-диаграммы) плюс
опциональную секцию 9 (custom prompt по Фазе 6).

Что критично при заполнении:

- Заполни **все** секции. Где данных не хватает — `[НЕДОСТАТОЧНО ДАННЫХ]` +
  запись в «Открытые вопросы»
- Defaults стека (sqlc + goverter, gRPC + gateway, Database-per-service,
  Kafka для async) помечай `[ПОДТВЕРДИТЬ]`, если уверенности < 100%
- Раздел 4 (точки интеграции) разбей на inbound / outbound / Kafka
  consume — это критично для нашего стека и в шаблоне это разнесено
  в три подтаблицы
- Раздел 8 (sequence) — Mermaid-шаблон со стандартными участниками
  (Client → Gateway → gRPC handler → Usecase → Postgres / Redis Streams /
  Valkey / Integration / Kafka topic) есть в `summary-template.md`,
  переиспользуй его как заготовку

---

## Фаза 5: Ревью

`AskUserQuestion`:
- Всё ли корректно в диаграмме?
- Какие секции скорректировать?
- Какие компоненты или связи упущены?

Внеси правки и пройди чеклист заново.

---

## Фаза 6: Кастомный промпт

`AskUserQuestion`: «Дополнительный анализ?» (примеры: «план миграции на
event-driven», «оценка готовности к 10x нагрузке», «security review
checklist»). Варианты: `Ввести промпт` / `Пропустить`.

Если введён — добавь раздел 9 в SUMMARY:

```markdown
#### 9. Дополнительный анализ
**Запрос:** [промпт пользователя]
[Развёрнутый ответ]
```

---

## Правила и ограничения

1. Команда == источник истины для технологий и протоколов. Не спрашивай
   то, что выводится из кода.
2. **НЕ выдумывай** компоненты или связи, которых нет в коде. Помечай
   `[ПРЕДПОЛОЖЕНИЕ]`.
3. **Layout — святое.** Если что-то лежит вне `repository/cache/integration/kafka` —
   зафиксируй как «нестандартное размещение», поищи в `builder.go` через
   secretary-core и спроси у пользователя.
4. Сохраняй имена ровно из кода (имя физического хранилища, имя топика,
   имя rpc, имя `integration/*` папки).
5. LikeC4 и Mermaid должны рендериться без ошибок.
6. Defaults в SUMMARY помечай `[ПОДТВЕРДИТЬ]`, если уверенности < 100%.
7. Один `repository` элемент = одно физическое хранилище. Не дроби по
   sqlc-папкам.
8. Все Kafka-топики — внутри одного `externalSystem 'Kafka'`. Producer-
   стрелок не рисуй.
9. **Default scope — C1 + C2.** C3 (Components) делай только по явному
   запросу. C4 (Code) не делай — переадресуй в IDE / REPO_MAP.
10. **Если diagram.likec4 уже есть — расширяй через `Edit`, не
    перерисовывай через `Write`.** Это особенно важно при переходе
    C1+C2 → C3: новые элементы и view добавляются дельтой, существующие
    id/имена/связи сохраняются 1:1.

---

## Quality checklist

- [ ] Просканированы все папки layout (api, repository, cache, integration, kafka, cmd)
- [ ] Сделан fallback-скан `builder.go` на нестандартные интеграции (secretary-core, прямые grpc-клиенты)
- [ ] Сводная таблица компонентов показана пользователю и подтверждена
- [ ] Получены ответы на 3 обязательных вопроса (бизнес-задача, сценарии, аудитория)
- [ ] **Уровень C4 определён: по умолчанию C1 + C2; C3 — только если пользователь явно попросил**
- [ ] **Если делается C3 — добавлены element kinds `handler`/`usecase`/`component` + `relationship route`, есть отдельный `view components of <container>`, БД и externalSystem не дробятся**
- [ ] **Если `diagram.likec4` уже существовал — он расширен через `Edit` (новые element kinds, новые usecase'ы, новый `view components of`), а не перезаписан целиком; существующие id/имена/связи сохранены 1:1**
- [ ] **C4 (Code) не делается — если попросили, переадресовано в IDE / REPO_MAP**
- [ ] Каждый компонент классифицирован по правилу глоссария (repo/cache/integration/kafka)
- [ ] **`externalSystem` имеет `style { color muted }` в spec**
- [ ] **Все Kafka-топики обёрнуты в родительский `externalSystem 'Kafka'`**
- [ ] **Producer→topic стрелки отсутствуют (топик = источник сам по себе)**
- [ ] **Postgres/Redis/Valkey показаны как отдельные storage-элементы, даже если код использует несколько repository-пакетов на одну СУБД**
- [ ] **Container view имеет явный `include` со списком, не `*`**
- [ ] **Есть focused views: storage + incomingSync + incomingAsync + outgoing**
- [ ] **`autoLayout`: `TopBottom` для context/containers, `LeftRight` для focused**
- [ ] **Внешние системы, существующие только как Kafka-producers, НЕ включены в model**
- [ ] LikeC4 содержит Context + Container + focused views
- [ ] Specification block содержит элементы repository/cache/queue/externalSystem/service; custom relationship kinds — только если реально нужна визуальная разница, иначе spec минимальный
- [ ] **Связи не используют третий позиционный аргумент — kind, если есть, через `-[kind]->`, никогда не `a -> b 'label' 'kind'`**
- [ ] **Однотипные application-компоненты (handlers/strategies/per-state UC) схлопнуты в один обобщённый блок, имена — в `description`**
- [ ] Все связи имеют label
- [ ] Раздел 4 SUMMARY разбит на inbound / outbound / Kafka (только consume)
- [ ] Defaults в разделе 6 либо подтверждены, либо помечены `[ПОДТВЕРДИТЬ]`
- [ ] Sequence-диаграммы используют стандартных участников
- [ ] Каждая sequence содержит примечания по edge cases и ошибкам
- [ ] Нет выдуманных компонентов вне layout (всё `[ПРЕДПОЛОЖЕНИЕ]` подтверждено)
- [ ] Если есть нестандартное размещение — зафиксировано в «Открытые вопросы»
- [ ] Пользователю предложена Фаза 6
- [ ] Файлы записаны через `Write`

После прохождения — выведи результат пользователю. Если пункт упёрся в
нехватку данных — `AskUserQuestion`, исправь, пройди заново.
