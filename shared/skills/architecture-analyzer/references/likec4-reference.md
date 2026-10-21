# LikeC4 DSL — справочник синтаксиса

Используй этот синтаксис для архитектурных диаграмм As Is и To Be.
Эталонный пример ниже отражает реальный сервис нашего стека и покрывает
все ключевые паттерны команды. Используй его как шаблон.

---

## Уровни C4 — что делаем и не делаем

| Уровень          | Что показывает                                               | Делаем?              |
|------------------|--------------------------------------------------------------|----------------------|
| **C1 Context**   | Система как чёрный ящик + актеры + внешние системы           | ✅ всегда            |
| **C2 Container** | Процессы / БД / очереди системы; стек технологий             | ✅ всегда            |
| **C3 Component** | Внутреннее устройство одного контейнера: handlers, usecases  | ⏸ только по запросу |
| **C4 Code**      | Классы / интерфейсы внутри компонента                        | ❌ нет, см. IDE      |

**Default scope** этого справочника — **C1 + C2**. Эталонный пример
Reception Service ниже относится к этим уровням.

**C3** — отдельная секция в конце документа: дополнительные element
kinds (`handler`, `usecase`, `component`), `relationship route` для
вызовов между usecase'ами, отдельный `view components of <container>`.
Эталон C3 — соседний `diagram.likec4` (если есть).

---

## Эталонный пример — Reception Service

Демонстрирует:

- `externalSystem` со `style { color muted }` для визуального отличия
- `relationship redis` отдельно от `relationship valkey` (legacy Redis /
  Redis Streams ≠ Valkey-кэш)
- **Trihead service layout**: `gateway` (REST proxy) + `grpcApi` (бизнес-
  логика) + `kafkaConsumers` (async daemons) — один процесс, три способа
  взаимодействия
- **Один `repository` = одно физическое хранилище.** Список таблиц и
  путей sqlc-репозиториев — в `description`. Postgres + Redis Streams —
  отдельные элементы; плюс Valkey как `cache`
- **Все Kafka-топики обёрнуты в `externalSystem 'Kafka'`.** Связи только
  `kafka.topic -> service.kafkaConsumers` (consume direction); producer-
  стрелок нет
- **Nested decomposition** для T-IVR: внутри `externalSystem` —
  под-внешние системы для разных ролей (IVR-робот, DP-робот)
- **Focused views** вместо одной мега-диаграммы: `context`, `containers`
  с явным `include`, плюс `storage`, `incomingSync`, `incomingAsync`,
  `outgoing`
- `autoLayout TopBottom` для широких C1/C2; `LeftRight` для focused

```likec4
specification {
  element actor { style { shape person } }
  element system
  element service
  element repository { style { shape storage } }
  element cache { style { shape storage } }
  element queue { style { shape queue } }
  element externalSystem {
    style {
      color muted
    }
  }

  relationship grpc
  relationship rest
  relationship sql
  relationship valkey
  relationship redis
  relationship kafka
}

model {
  // ===== Наша система =====
  reception = system 'Reception Service' {
    description 'Приём и маршрутизация обращений клиентов'

    // --- Trihead service layout ---
    gateway = service 'gateway' {
      description 'REST proxy через grpc-gateway'
      technology 'Go, grpc-gateway'
    }

    grpcApi = service 'grpcApi' {
      description 'gRPC API + бизнес-логика'
      technology 'Go, grpc'
    }

    kafkaConsumers = service 'kafkaConsumers' {
      description 'Async-обработчики событий из Kafka'
      technology 'Go'
    }

    // --- Storage: одно физическое хранилище = один элемент ---
    pg = repository 'PostgreSQL' {
      description 'Реляционное хранилище. Таблицы: user_preferences, registered_phones, person_profile_ids, global_keywords. Доступ: internal/repository/{userpreferences,registeredphones,personprofileids,globalkeywords}.'
      technology 'PostgreSQL, sqlc + goverter + gowrap'
    }

    redis = repository 'Redis Streams' {
      description 'Durable-очередь команд. Доступ: internal/repository/commands/.'
      technology 'Redis Streams'
    }

    valkey = cache 'Valkey' {
      description 'Rebuildable cache для ответов профильной платформы. Доступ: internal/cache/profilescache.go.'
      technology 'Valkey'
    }
  }

  // ===== Внешние системы (sync inbound) =====
  mobileBank = externalSystem 'Mobile Bank' {
    description 'Мобильное приложение, REST через gateway.'
  }

  // Nested decomposition: T-IVR содержит два разных робота
  tivr = externalSystem 'T-IVR Bank (TWork)' {
    description 'Платформа голосовых роботов.'

    robotIvr = externalSystem 'Голосовой робот на IVR' {
      description 'Классический IVR-робот.'
    }
    robotDp = externalSystem 'Голосовой робот на DP' {
      description 'Робот на платформе DP.'
    }
  }

  // ===== Внешние системы (sync outbound) =====
  // Заметь: интеграции через secretary-core (не internal/integration/*)
  // оформляются как обычные externalSystem с пометкой в description.
  profilesPlatform = externalSystem 'Profiles Platform' {
    description 'Платформа клиентских профилей. Клиент через secretary-core/profilesplatform (нестандартное размещение).'
  }
  denorm = externalSystem 'Denormalization Service' {
    description 'Сервис денормализации. Клиент через secretary-core/denormalization.'
  }

  // ===== Kafka — единая шина с топиками внутри =====
  kafka = externalSystem 'Kafka' {
    description 'Шина событий.'

    topicCardOps = queue 'card.operations' {
      description 'События операций по карте. Consumer: internal/kafka/cardoperations/.'
      technology 'Kafka, Avro'
    }
    topicAuthEvents = queue 'auth.events' {
      description 'События аутентификации. Consumer: internal/kafka/authevents/.'
      technology 'Kafka, JSON'
    }
  }

  // ===== Связи: incoming sync =====
  mobileBank -[rest]-> reception.gateway 'GET /api/preferences' {
    technology 'REST/HTTPS'
  }
  tivr.robotIvr -[grpc]-> reception.grpcApi 'GetGreeting' {
    technology 'gRPC'
  }
  tivr.robotDp -[grpc]-> reception.grpcApi 'GetCustomerProfile' {
    technology 'gRPC'
  }

  // ===== Связи: incoming async (Kafka consume — стрелка от топика) =====
  // Producer→topic стрелки НЕ рисуем: имя топика само указывает источник.
  kafka.topicCardOps -[kafka]-> reception.kafkaConsumers 'Card events' {
    technology 'Kafka'
  }
  kafka.topicAuthEvents -[kafka]-> reception.kafkaConsumers 'Auth events' {
    technology 'Kafka'
  }

  // ===== Связи: gateway → grpcApi (внутри system) =====
  reception.gateway -[grpc]-> reception.grpcApi 'Proxy REST → gRPC' {
    technology 'gRPC'
  }

  // ===== Связи: storage =====
  reception.grpcApi -[sql]-> reception.pg 'CRUD' { technology 'sqlc/Postgres' }
  reception.grpcApi -[redis]-> reception.redis 'XADD/XREAD commands' { technology 'Redis' }
  reception.grpcApi -[valkey]-> reception.valkey 'Cache profiles' { technology 'Valkey' }
  reception.kafkaConsumers -[sql]-> reception.pg 'Persist events' { technology 'sqlc/Postgres' }
  reception.kafkaConsumers -[redis]-> reception.redis 'Append commands' { technology 'Redis' }

  // ===== Связи: outgoing sync =====
  reception.grpcApi -[grpc]-> profilesPlatform 'Get profile' { technology 'gRPC' }
  reception.grpcApi -[grpc]-> denorm 'Denormalize' { technology 'gRPC' }
}

// ===== Focused views =====
views {
  view context of reception {
    title 'Reception — Context (C1)'
    include *
    autoLayout TopBottom
  }

  view containers of reception {
    title 'Reception — Container (C2)'
    // Явный include — `*` иногда теряет nested storage внутри system
    include
      reception, reception.*,
      mobileBank,
      tivr, tivr.*,
      profilesPlatform,
      denorm,
      kafka, kafka.*
    autoLayout TopBottom
  }

  view storage {
    title 'Reception — Storage'
    include reception.pg, reception.redis, reception.valkey,
            reception.grpcApi, reception.kafkaConsumers
    autoLayout LeftRight
  }

  view incomingSync {
    title 'Reception — Incoming sync'
    include mobileBank, tivr, tivr.*,
            reception.gateway, reception.grpcApi
    autoLayout LeftRight
  }

  view incomingAsync {
    title 'Reception — Incoming async (Kafka)'
    include kafka, kafka.*, reception.kafkaConsumers,
            reception.pg, reception.redis
    autoLayout LeftRight
  }

  view outgoing {
    title 'Reception — Outgoing sync'
    include reception.grpcApi, profilesPlatform, denorm
    autoLayout LeftRight
  }
}
```

---

## Ключевые правила синтаксиса

- Каждый элемент имеет уникальный идентификатор (camelCase)
- Строковые значения в одинарных кавычках: `'текст'`
- Связи: `источник -> приёмник 'описание'`
- Кастомные relationship: `источник -[имя]-> приёмник` (например, `-[grpc]->`)
- Вложенность определяет иерархию (system > service / repository / cache /
  queue; externalSystem может содержать вложенные externalSystem или queue)
- `include *` во view включает все дочерние элементы; для надёжного
  C2 предпочитай явный `include` со списком
- `technology '...'` — атрибут связи и/или элемента
- `autoLayout TopBottom | LeftRight | BottomTop | RightLeft` — направление
  раскладки во view

### Связи — допустимые формы и грабля парсера

```likec4
// Обычная связь с label
a -> b 'label'

// С kind (если объявлен в spec)
a -[grpc]-> b 'label'

// С блоком атрибутов
a -> b 'label' { technology 'gRPC' }
```

**Никогда** не пиши третий позиционный аргумент-строкой:

```likec4
// ОШИБКА — `FqnRef is empty`, dev-server валится
a -> b 'label' 'grpc'
```

Парсер не понимает третью строку как kind и роняет всю модель. Это
первая по частоте грабля при ручной верстке.

---

## Kafka — наш канон

В LikeC4 нет встроенного «kafka-consumer». В команде закреплён один
паттерн, который даёт читаемые диаграммы и совпадает с реальностью:

1. **Все топики — внутри одного `externalSystem 'Kafka'`.** Это даёт
   визуальный блок и отражает, что Kafka — одна shared-инфраструктура,
   а не N независимых систем.
2. **Стрелка `kafka.topic -> service.kafkaConsumers`** для consume.
   Топик — наверху диаграммы (inbound), сервис — посередине; естественное
   направление потока событий.
3. **Producer-стрелки не рисуем.** Имя топика само указывает источник.
   Если хочется отметить producer — это делается описанием в самом
   `queue`, не отдельной стрелкой.
4. **Внешние системы, которые существуют только как Kafka-producers,
   не добавляются в model.** Топик и так показывает, откуда пришли
   данные.

```likec4
specification {
  element service
  element queue { style { shape queue } }
  element externalSystem { style { color muted } }
  relationship kafka
}

model {
  ourSvc = service 'Our Service'

  kafka = externalSystem 'Kafka' {
    description 'Шина событий.'

    orderEvents = queue 'order.events' {
      description 'Lifecycle заказов. Consumer: internal/kafka/orderevents/.'
      technology 'Kafka, Avro'
    }
    paymentEvents = queue 'payment.events' {
      description 'Платежи. Consumer: internal/kafka/paymentevents/.'
      technology 'Kafka, JSON'
    }
  }

  // Только consume — от топика к сервису
  kafka.orderEvents -[kafka]-> ourSvc 'order lifecycle' { technology 'Kafka' }
  kafka.paymentEvents -[kafka]-> ourSvc 'payment events' { technology 'Kafka' }
}
```

**Антипаттерны:**

- Топики плоско в `model`, не сгруппированные → autoLayout растягивает
  их в один ряд с другими элементами, диаграмма становится нечитаемой
- `service -> kafka.topic` для producer → лишний шум; имя топика и
  description достаточны
- Внешний producer (например, forward, mvno) добавлен как отдельный
  `externalSystem` только ради стрелки в топик → удаляй

---

## Storage — гранулярность и Redis vs Valkey

**Один `repository` = одно физическое хранилище.** Не дроби по
sqlc-папкам.

```likec4
pg = repository 'PostgreSQL' {
  description 'Реляционное хранилище. Таблицы: a, b, c. Доступ: internal/repository/{a,b,c}.'
  technology 'PostgreSQL, sqlc + goverter + gowrap'
}
```

**Redis vs Valkey:** одно физическое имя != одно назначение.

| Папка                         | Тип    | C4 элемент   | Когда                                          |
|-------------------------------|--------|--------------|------------------------------------------------|
| `internal/repository/<name>/` (Redis) | durable | `repository` | Redis Streams для гарантированной доставки команд / событий |
| `internal/cache/<name>.go` (Valkey)   | rebuildable | `cache` | Read-through / cache-aside / cache-native (сессии, флаги) |

Один проект может одновременно иметь **`repository redis`** (durable
Streams) **и `cache valkey`** (rebuildable). Не объединяй — это два
разных C4-элемента, и для читателя важно различать «потеря данных =
инцидент» от «потеря данных = только латенси».

```likec4
specification {
  element repository { style { shape storage } }
  element cache { style { shape storage } }

  relationship sql
  relationship redis    // Redis Streams (durable)
  relationship valkey   // Valkey (cache)
}

model {
  ourSvc = service 'Our Service'

  redis = repository 'Redis Streams' {
    description 'Durable command queue.'
    technology 'Redis Streams'
  }
  valkey = cache 'Valkey' {
    description 'Cache profiles, rebuildable.'
    technology 'Valkey'
  }

  ourSvc -[redis]-> redis 'XADD command' { technology 'Redis' }
  ourSvc -[valkey]-> valkey 'GetProfile' { technology 'Valkey' }
}
```

**Cache patterns (paterns названия и направления):**

- **Read-through декоратор** — `service -> cache -> repository`. Cache
  обёртывает репозиторий
- **Cache-aside** — `service -> cache` и параллельно `service -> repo`
- **Cache-native** — только `service -> cache`, репозитория нет
  (сессии, feature flags, rate limits)

---

## Layout — позиционирование inbound / outbound

C4 формально не предписывает направление, но устоявшаяся convention
для component-уровня:

```
┌─────────────────────────────────────────────────┐
│  TOP — inbound:                                 │
│  callers (gRPC/HTTP), потребляемые Kafka топики │
├─────────────────────────────────────────────────┤
│  MIDDLE — наш сервис                            │
├─────────────────────────────────────────────────┤
│  BOTTOM — зависимости:                          │
│  Postgres / Redis Streams / Valkey,             │
│  integration/* (sync outbound)                  │
└─────────────────────────────────────────────────┘
```

Логика — направление зависимости: всё, что снизу, **наш сервис зависит**
от этого. Всё, что сверху — **зависит от нас**. Читается за секунду.

В LikeC4 это выражается двумя способами:

1. **`autoLayout TopBottom`** во view — общее направление раскладки
2. **`rank` constraints** — точное закрепление группы элементов

```likec4
view containers of ourSvc {
  title 'Containers'
  include *
  autoLayout TopBottom

  // Inbound — вверх
  rank source {
    client,
    kafka.consumedTopic
  }

  // Storage + outbound — вниз
  rank sink {
    ourSvc.pg,
    ourSvc.redis,
    ourSvc.valkey,
    externalDownstream
  }

  // (опционально) выровнять группу на одном уровне
  rank same {
    ourSvc.pg,
    ourSvc.redis,
    ourSvc.valkey
  }
}
```

**Допустимые значения `rank`:**

| Значение | Эффект                                          |
|----------|-------------------------------------------------|
| `source` | Эксклюзивно в начале (top) диаграммы            |
| `sink`   | Эксклюзивно в конце (bottom)                    |
| `min`    | Ближе к началу (мягче, чем `source`)            |
| `max`    | Ближе к концу (мягче, чем `sink`)               |
| `same`   | Элементы на одном уровне                        |

**Практическое правило для нашего стека:**

- `rank source`: actors, caller-сервисы, **топики которые мы consume**
- `rank sink`: `repository/*` (Postgres / Redis Streams), `cache/*`
  (Valkey), `integration/*` (внешние сервисы которые мы зовём)
- `rank same` для одинаковых по типу: все БД на одном уровне, все
  кэши на одном уровне

**Caveat:** rank — это hints для Graphviz, а не жёсткий override. Они
комбинируются с автолейаутом, а не подменяют его. Применяй sparingly —
только для якорных групп.

---

## Выбор `autoLayout`

| View                          | autoLayout | Почему                                                  |
|-------------------------------|------------|---------------------------------------------------------|
| `context` (C1)                | TopBottom  | Много внешних систем; иначе всё в один длинный ряд      |
| `containers` (C2)             | TopBottom  | Inbound сверху, storage/outbound снизу — естественно    |
| `storage` (focused)           | LeftRight  | Сервис слева → хранилища справа                         |
| `incomingSync` (focused)      | LeftRight  | Caller → gateway → grpcApi                              |
| `incomingAsync` (focused)     | LeftRight  | Kafka topic → consumer → storage                        |
| `outgoing` (focused)          | LeftRight  | grpcApi → внешний сервис                                |
| `components` (C3)             | LeftRight  | Поток вызовов между usecase'ами                         |
| `stateRouting` (C3 focused)   | LeftRight  | Конкретный сценарий: kafka → router → handler → uc      |

---

## C3 Components — паттерн (только по запросу)

**Когда применять.** Только если пользователь явно попросил уровень
компонентов («покажи components», «уровень C3», «внутренности
kafkaConsumers», «как устроена бизнес-логика»). По умолчанию остаёмся
на C1 + C2.

**Зачем.** Stateful сервисы с роутингом по состоянию или с большим
количеством переплетённых usecase'ов (боты, FSM, оркестраторы)
читаются плохо на C2. C3 показывает: какие handlers/usecases есть,
как они вызывают друг друга, какие из них ходят в БД / внешние сервисы.

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
  `kafkaConsumers`. Не дроби все сразу
- `handler` — тонкий dispatcher (`internal/handler/`)
- `usecase` — бизнес-логика (`internal/usecase/<name>/`,
  `internal/<domain>/`); имя папки — в `description`
- `component` — generic fallback
- Связи между usecase'ами — `relationship route` (вызов метода)
- БД, внешние системы остаются на C2-уровне (`repository`,
  `externalSystem`); usecase их использует, но не дробит
- **Схлопывай однотипные компоненты:** 5 хендлеров с одинаковыми
  связями → один блок, имена в `description`

**Пример (упрощённый — fraud-roulette-bot):**

```likec4
specification {
  // ... C1/C2 spec ...
  element handler { style { shape rectangle } }
  element usecase { style { shape rectangle } }
  relationship route
}

model {
  bot = system 'fraud-roulette-bot' {
    kafkaConsumers = service 'Kafka Consumers' {
      description 'Два daemon-консьюмера: maxsexic и fraudroulette.'
      technology 'Go, aic-go-common/kafka'
    }

    routerUC = usecase 'maxui Usecase (router)' {
      description 'Точка входа. Читает chat_state, роутит в нужный StateHandler.'
      technology 'internal/usecase/maxui/'
    }

    stateHandler = handler 'State Handler' {
      description 'Тонкий диспетчер. Один из 5 (sharecontact / awaitingletsplay / onboarding / mainmenu / advicemenu) — выбирается мапой state.State в builder.go.'
      technology 'internal/handler/'
    }

    uiUC = usecase 'UI Usecase' {
      description 'Меняет state в PG, формирует исходящие сообщения.'
      technology 'internal/max/'
    }

    messengerUC = usecase 'messenger UC' {
      description 'Адаптер над sexic + s3.'
      technology 'internal/usecase/messenger/'
    }

    pg = repository 'PostgreSQL' {
      description 'Таблицы: chat_states, registered_phones.'
      technology 'PostgreSQL'
    }
  }

  kafka = externalSystem 'Kafka' {
    maxEvents = queue 'max.events' {
      description 'Входящие сообщения от пользователя в Max.'
      technology 'Kafka, Protobuf'
    }
  }

  sexic = externalSystem 'Sexic (Max API)' {
    description 'Платформа отправки сообщений.'
  }

  // Внешний поток
  kafka.maxEvents -[kafka]-> bot.kafkaConsumers 'consume'

  // Внутренние route-связи (вызовы методов)
  bot.kafkaConsumers -[route]-> bot.routerUC 'HandleStart/Text/Contact'
  bot.routerUC -[route]-> bot.stateHandler 'по state.State'
  bot.stateHandler -[route]-> bot.uiUC 'method call'
  bot.uiUC -[route]-> bot.messengerUC 'send'

  // SQL — осталось на C2-уровне, не дробится
  bot.routerUC -[sql]-> bot.pg 'GetChatState'
  bot.uiUC -[sql]-> bot.pg 'save state'

  // Outbound
  bot.messengerUC -[rest]-> sexic 'Send / SendAudio'
}
```

**Views для C3:**

```likec4
view components of <container> {
  title '<service> — Components (C3)'
  description 'Внутреннее устройство <container>.'
  include
    <container>.*,
    <соседние Kafka-топики, БД, внешние системы для контекста>
  autoLayout LeftRight
}

// Опциональный focused view — конкретный сценарий
view stateRouting {
  title '<service> — Маршрутизация входящего сообщения'
  description 'kafka consumer → router → state handler → ui usecase → messenger.'
  include
    kafka.maxEvents,
    bot.kafkaConsumers,
    bot.routerUC,
    bot.stateHandler,
    bot.uiUC,
    bot.messengerUC,
    bot.pg,
    sexic
  autoLayout LeftRight
}
```

**Антипаттерны C3:**

- Делать C3 без явного запроса — пользователю нужен был C1+C2, шум
- Дробить БД и externalSystem (они на C2 уровне, не дроби `pg` на
  таблицы или `sexic` на endpoints)
- Не схлопывать однотипные usecase'ы — 5 одинаковых блоков с
  одинаковыми связями делают диаграмму нечитаемой
- Использовать сетевые relationships (`grpc`, `rest`) для вызовов
  методов внутри процесса — это `route`
