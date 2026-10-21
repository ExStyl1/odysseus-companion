---
name: "repo-analysis"
description: "Исследование структуры репозитория приложения и определение его зависимостей."
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


# Анализ репозитория

## Цель навыка

Анализ репозитория с исходным кодом системы для выявления всех внешних зависимостей и предоставляемых API. Результат анализа используется для построения диаграмм архитектуры системы (C2 — диаграмма контейнеров).

## Типы выявляемых зависимостей

### 1. Базы данных

**Где искать:**
- Файлы конфигурации: `application.yml`, `application.properties`, `config.yaml`, `.env`
- Код подключения к БД: драйверы, ORM-конфигурации
- Миграции БД: папки `migrations/`, `db/migrate/`, `flyway/`, `liquibase/`
- Docker Compose: `docker-compose.yml`, `docker-compose*.yml`

**Специфика по стекам:**

| Стек | Где искать |
|------|------------|
| **Spring Boot** | `application.yml/properties`, `@Configuration` с `DataSource`, `application-*.yml` для профилей |
| **Scala + Akka** | `application.conf` (HOCON), `jdbc` секции |
| **Scala + cats.effect** | `application.conf`, код с `HikariDataSource`, `skunk.Session` |
| **Scala + ZIO** | `application.conf`, `ZIO JDBC` конфигурации, `zio.jdbc.JDBCConfig` |
| **.NET** | `appsettings.json`, `ConnectionStrings`, `Startup.cs` |
| **NodeJS** | `.env`, `config/`, Sequelize/TypeORM/Pg конфигурации |
| **Golang** | `.env`, `config.yaml`, `sql.Open()`, GORM `Open()` |

**Что искать:**
- PostgreSQL, MySQL, MariaDB, Oracle, MSSQL, MongoDB
- Connection strings, JDBC URL, DSN
- Хосты, порты, имена баз данных

### 2. Кэши на базе Redis

**Где искать:**
- Файлы конфигурации приложения
- Код инициализации Redis-клиента
- Docker Compose файлы

**Специфика по стекам:**

| Стек | Где искать |
|------|------------|
| **Spring Boot** | `@EnableCaching`, `RedisTemplate`, `Lettuce`, `Jedis` конфигурации |
| **Scala + Akka** | `redis` секции в `application.conf`, `akka-redis` |
| **Scala + cats.effect** | `RedisClient` из `cats-effect-redis`, `application.conf` |
| **Scala + ZIO** | `ZIO Redis`, `RedisConfig` |
| **.NET** | `StackExchange.Redis`, `ConnectionMultiplexer`, `appsettings.json` |
| **NodeJS** | `redis` пакет, `createClient()`, `ioredis` |
| **Golang** | `go-redis`, `redis.NewClient()`, `redis.ParseURL()` |

**Что искать:**
- Redis connection strings (redis://...)
- Хосты и порты Redis (обычно 6379)
- Конфигурации Redis Cluster, Sentinel

### 3. Хранилища S3

**Где искать:**
- Конфигурации облачных хранилищ
- Код инициализации S3-клиентов

**Специфика по стекам:**

| Стек | Где искать |
|------|------------|
| **Spring Boot** | `@Configuration` с `S3Client`, `aws-java-sdk-s3` зависимости |
| **Scala + Akka** | `aws-sdk` зависимости, код с `S3Client` |
| **Scala + cats.effect/ZIO** | `fs2-aws-s3`, `zio-aws-s3`, конфигурации в `application.conf` |
| **.NET** | `AWSSDK.S3`, `AmazonS3Client`, `appsettings.json` |
| **NodeJS** | `@aws-sdk/client-s3`, `S3Client`, `aws-sdk` |
| **Golang** | `aws-sdk-go`, `s3.New()`, конфигурации в коде |

**Что искать:**
- Endpoint URL (AWS S3, MinIO, Ceph)
- Имена бакетов
- Region, credentials

### 4. Синхронные вызовы других сервисов (REST / HTTP / gRPC)

**Где искать:**
- Конфигурации HTTP-клиентов
- gRPC stubs и конфигурации
- Код HTTP-запросов

**Специфика по стекам:**

| Стек | Где искать |
|------|------------|
| **Spring Boot** | `@FeignClient`, `RestTemplate`, `WebClient`, `@Value` с URL-свойствами, `*-client-spring-boot-starter` в build-файле, `application.yml` с секциями `*.url`/`*.endpoint` |
| **Scala + Akka** | `akka-http-client`, `application.conf` с `http` секциями |
| **Scala + cats.effect** | `http4s.Client`, `sttp`, `application.conf` |
| **Scala + ZIO** | `zio-http`, `ZIO Http Client`, конфигурации |
| **.NET** | `HttpClient`, `IHttpClientFactory`, `appsettings.json` с `BaseAddress` |
| **NodeJS** | `axios`, `node-fetch`, `undici`, `http` модуль |
| **Golang** | `http.Client`, `http.NewRequest()`, `grpc.Dial()` |

**Что искать:**
- URL внешних сервисов (http://, https://)
- gRPC endpoints (host:port)
- Имена сервисов в service discovery
- Конфигурации retry, timeout, circuit breaker
- **Для Spring Boot — дополнительно:** `@Value`-аннотации с URL-свойствами (`@Value("${...url...}")`, `@Value("${...endpoint...}")`), а также все `*-client-spring-boot-starter` в build-файле (см. Шаг 2а)

### 5. Kafka: чтение и запись в топики

**Где искать:**
- Конфигурации Kafka
- Код продюсеров и консьюмеров
- Конфигурации topics

**Специфика по стекам:**

| Стек | Где искать |
|------|------------|
| **Spring Boot** | `@KafkaListener`, `@KafkaHandler`, `KafkaTemplate`, `application.yml` с `kafka` секциями |
| **Scala + Akka** | `akka-kafka` (Alpakka), `application.conf` с `kafka` секциями |
| **Scala + cats.effect** | `fs2-kafka`, `KafkaConsumer`, `KafkaProducer` |
| **Scala + ZIO** | `zio-kafka`, `Consumer`, `Producer` конфигурации |
| **.NET** | `Confluent.Kafka`, `ConsumerConfig`, `ProducerConfig` |
| **NodeJS** | `kafkajs`, `node-rdkafka`, `Consumer`, `Producer` |
| **Golang** | `sarama`, `confluent-kafka-go`, `NewConsumer()`, `NewProducer()` |

**Что искать:**
- Kafka bootstrap servers (host:port, обычно 9092)
- Имена топиков для чтения (consumer topics)
- Имена топиков для записи (producer topics)
- Consumer groups

**Важное правило определения владельца топика:**
- Если имя топика содержит префикс/суффикс исследуемой системы или система-владелец топика — исследуемая система, то такие топики считаются **предоставляемым API**
- Если топик принадлежит другой системе — исследуемая система **зависит от системы-владельца** по Kafka

### 6. Предоставляемое REST API / gRPC API

**Где искать:**
- Контроллеры, handlers, routes
- gRPC service определения
- Конфигурации портов

**Специфика по стекам:**

| Стек | Где искать |
|------|------------|
| **Spring Boot** | `@RestController`, `@Controller`, `@RequestMapping`, `@GetMapping`, `@PostMapping` |
| **Scala + Akka** | `akka-http` routes, `path()`, `get()`, `post()` директивы |
| **Scala + cats.effect** | `http4s` `HttpRoutes`, `Router`, `@route` аннотации |
| **Scala + ZIO** | `zio-http` `Routes`, `Http`, `@http` аннотации |
| **.NET** | `[ApiController]`, `[Route]`, `[HttpGet]`, `[HttpPost]`, Controllers |
| **NodeJS** | `app.get()`, `app.post()`, `router.`, Express/Fastify routes |
| **Golang** | `http.HandleFunc`, `mux.Router`, `gin.Router`, `echo.Group` |

**Классификация API:**
- **Public (для фронтов)**: API для браузерных клиентов, мобильных приложений
  - Искать: `/api/v1/`, `/public/`, `/web/`, CORS настройки для frontend
- **Internal**: API для внутреннего взаимодействия между сервисами
  - Искать: `/internal/`, `/service/`, mTLS конфигурации, service-to-service auth
- **Admin**: Административное API для управления системой
  - Искать: `/admin/`, `/management/`, `/actuator/`, health checks, metrics

**Что фиксировать:**
- Endpoint paths (GET /api/users, POST /orders)
- gRPC service methods
- Порты прослушивания
- Типы аутентификации

### 7. Предоставляемое асинхронное API (Kafka topics)

**Где искать:**
- Конфигурации Kafka producer
- Код публикации сообщений
- Схемы сообщений (Avro, Protobuf, JSON Schema)

**Что фиксировать:**
- Имена топиков, которые система пишет (produces)
- Формат сообщений (схема)
- Ключи сообщений
- Consumer groups, которые должны читать эти топики

**Определение владельца:**
- Топики с именем вида `{system-name}.*` или `*.{system-name}.*` принадлежат системе
- Такие топики считаются **предоставляемым асинхронным API**

## Определение назначения зависимости

Для каждой найденной зависимости необходимо определить **цель использования** (purpose). Анализ проводится по следующим признакам:

### 1. Анализ DTO-объектов

**Где искать DTO:**
- `dto/`, `models/`, `entities/`, `domain/` пакеты
- Классы с суффиксами: `Dto`, `Request`, `Response`, `Event`, `Message`, `Record`
- Protobuf/Avro схемы: `.proto`, `.avsc` файлы

**Что анализировать:**
- Имена полей DTO говорят о назначении: `userId`, `orderId`, `paymentAmount`
- Названия самих DTO: `UserCreatedEvent`, `PaymentRequest`, `OrderConfirmation`
- Комментарии к DTO классам и полям

### 2. Анализ названий пакетов

**Примеры пакетов и их значение:**

| Пакет | Назначение |
|-------|------------|
| `auth`, `security` | Аутентификация, авторизация |
| `payment`, `billing` | Платежи, биллинг |
| `order`, `cart` | Заказы, корзина |
| `user`, `customer`, `client` | Пользователи, клиенты |
| `notification`, `email`, `sms` | Уведомления |
| `report`, `analytics` | Отчётность, аналитика |
| `integration`, `external` | Интеграции с внешними системами |

### 3. Анализ названий сервисов

**Примеры сервисов и их значение:**

| Сервис | Назначение |
|--------|------------|
| `UserService`, `UserRepository` | Управление пользователями |
| `PaymentService`, `PaymentGateway` | Обработка платежей |
| `OrderService`, `OrderProcessor` | Обработка заказов |
| `NotificationService`, `EmailSender` | Отправка уведомлений |
| `AuthService`, `TokenService` | Аутентификация, токены |
| `CacheService`, `CacheManager` | Кэширование данных |
| `IntegrationService`, `ExternalApiClient` | Интеграции |

### 4. Анализ комментариев

**Где искать:**
- ScalaDoc, JavaDoc, KDoc комментарии над классами и методами
- Inline комментарии в коде
- README файлы в директориях с кодом

**Что искать:**
- Описания назначения классов: `// Service for processing payments`
- Описания бизнес-логики: `// Sends notification to customer on order completion`
- Ссылки на тикеты/документацию

### 5. Анализ имён переменных и методов

**Примеры:**
- `sendPaymentConfirmation()` → отправка подтверждений платежей
- `fetchUserProfile()` → получение профиля пользователя
- `publishOrderCreatedEvent()` → публикация события создания заказа
- `validateAuthToken()` → валидация токена аутентификации

## Алгоритм анализа

### Шаг 1: Определение стека технологий

1. Прочитать файлы зависимостей:
   - **Spring Boot**: `pom.xml`, `build.gradle.kts` с `spring-boot`
   - **Scala + Akka**: `build.sbt` с `akka-http`, `akka-actor`
   - **Scala + cats.effect**: `build.sbt` с `cats-effect`, `fs2`
   - **Scala + ZIO**: `build.sbt` с `zio`, `zio-kafka`
   - **.NET**: `*.csproj` с `Microsoft.AspNetCore`
   - **NodeJS**: `package.json`
   - **Golang**: `go.mod`

2. Определить язык и фреймворк по структуре проекта

3. **Для Spring Boot:** В build-файлах дополнительно собери список всех `*-client-spring-boot-starter` и `*-spring-boot-starter` зависимостей с групповым идентификатором, указывающим на внутренние сервисы компании. Это клиенты к внешним системам, реализованные в библиотеках — они автоконфигурируются без явных `@FeignClient` в коде репозитория, а их URL задаётся только через конфигурацию.

   Паттерн для поиска в build-файлах:
   ```
   [a-z-]+-client-spring-boot-starter
   ```

### Шаг 1а: Анализ библиотек из index.md (для Spring Boot)

**Важно:** Некоторые клиентские зависимости могут быть реализованы в общих библиотеках (например, `sme-credit-commons`), которые не являются `*-client-spring-boot-starter`, но содержат клиентские классы для вызова других систем.

1. Проверь наличие файла `index.md` в директории системы (для архитектурного репозитория).

2. Если в `index.md` есть секция `libraries:` с ссылками на GitLab-репозитории:
   - Склонируй каждую библиотеку во временную папку
   - Проанализируй её содержимое на наличие клиентских классов

3. **Что искать в библиотеках:**
   - Классы с суффиксами: `*Client`, `*ApiClient`, `*ServiceClient`
   - Пакеты с названиями: `client/`, `adapter/`, `integration/`
   - Конфигурации URL в `application.yml` внутри библиотеки
   - Использование `@FeignClient`, `RestTemplate`, `WebClient` в коде библиотеки

4. **Для каждого найденного клиента в библиотеке:**
   - Определи целевую систему по имени класса (например, `InternalApplicationStoreClient` → `origination`)
   - Найди URL для этого клиента в конфигурации исследуемого репозитория
   - Зафиксируй зависимость с назначением на основе анализа методов клиента

5. **Сопоставление с системами из архитектурного репозитория:**
   - После анализа всех зависимостей, выполни поиск в файлах `systems.puml` (в `docs/systems/`, `docs/systems/*/systems.puml`, `docs/systems_ext.puml`, `docs/systems/3rd-systems/systems.puml`)
   - Для каждой найденной зависимости проверь, существует ли уже процедура `System*()` или `System*_Ext()` с похожим именем
   - **Правила сопоставления:**
     - `role_app` → `SystemRoleApp_Ext` или `SystemRoleApp`
     - `tcrm` → `SystemCompanyProfile_Ext` или `SystemTcrm_Ext`
     - `smev` → `SystemSmev_Ext` (добавить в `systems.puml` если нет)
     - `siebel` → `SystemSiebel_Ext`
     - `dadata` → `SystemDadata_Ext`
     - Ищи по ключевым словам в имени процедуры
   - Если процедура найдена — используй её
   - Если процедура не найдена — **добавь её в соответствующий `systems.puml` файл** (не в диаграмму!):
     - Для систем внутри подразделения → `docs/systems/<отдел>/systems.puml`
     - Для внешних систем ТБанк → `docs/systems/3rd-systems/systems.puml`
     - Для внешних систем вне ТБанк → `docs/systems/systems_ext.puml`
     - Формат добавления:
       ```plantuml
       !unquoted procedure SystemSmev_Ext($alias)
       System_Ext($alias, "SMEV", "Валидация СМЭВ")
       !endprocedure
       ```

6. Очисти временную папку после анализа.

**Пример:**
```
Библиотека: sme-credit-commons
  ├── clients/
  │   ├── internal-application-store-client/
  │   │   └── src/main/kotlin/.../InternalApplicationStoreClient.kt  → зависит от origination
  │   ├── role-app-client/
  │   │   └── src/main/kotlin/.../RoleAppClient.kt  → зависит от roleapp (найдено в systems.puml: SystemRoleApp_Ext)
  │   ├── smev-client/
  │   │   └── src/main/kotlin/.../SmevClient.kt  → зависит от smev (добавить SystemSmev_Ext в systems.puml)
  │   └── ...
```

### Шаг 2: Поиск конфигурационных файлов

1. Найти все файлы конфигурации (в порядке приоритета — продакшн-конфиги содержат полный набор URL):
   - `configMap/prod/application.yml` и другие файлы в `configMap/prod/` или `configMap/` — **наиболее полный источник prod-зависимостей**
   - `src/main/resources/application.yml`, `application.properties`, `application.conf`
   - `config.yaml`, `config.json`
   - `.env`, `.env.*`
   - `docker-compose*.yml`
   - Kubernetes manifests: `k8s/`, `helm/`

### Шаг 2а: Инвентаризация HTTP-зависимостей из конфигурации (приоритетный метод)

**Важно:** HTTP-клиенты, реализованные через `*-client-spring-boot-starter` библиотеки, не оставляют кода в репозитории. Их единственный след — URL-свойство в конфигурации. Этот шаг обязателен для Spring Boot и рекомендуется для любого стека.

1. Прочитай наиболее полный конфигурационный файл (обычно `configMap/prod/application.yml`).

2. Извлеки **все** свойства, значение которых является HTTP URL (начинается с `http://` или `https://`) или ссылкой `${...}` в контексте URL. Пропусти инфраструктурные URL:
   - Kafka `bootstrap-servers` (порты 9092/9093)
   - Kafka `schema.registry.url`
   - JDBC `jdbc:...`
   - SMTP `host`/`port`
   - Redis host/port
   - S3/object storage endpoint (если не REST API)

3. Каждое оставшееся URL-свойство — отдельная HTTP-зависимость. Имя сервиса выводи из ключа конфигурации:
   - `service.urls.bpm.sme-company-info: http://...` → сервис `sme-company-info`
   - `service.tcrm.endpoint: http://...` → сервис `tcrm`
   - `service.siebel.endpoint: http://...` → сервис `siebel`
   - `service.urls.ibul.endpoint: http://...` → сервис `ibul`

4. Для свойств-ссылок вида `${service.credit.foo.url}` найди итоговое значение в других конфиг-файлах (например `configMap/features/application.yml`).

5. Сопоставь найденные URL-свойства с `*-client-spring-boot-starter` зависимостями из build-файла для подтверждения — имена обычно совпадают по суффиксу:
   - `sme-credit-company-info-client-spring-boot-starter` ↔ `service.urls.bpm.sme-company-info`
   - `sme-credit-tcrm-client-spring-boot-starter` ↔ `service.tcrm.endpoint`

6. Для подтверждения назначения найди в коде файлы, импортирующие клиентский класс из библиотеки (поиск по имени класса, например `CompanyInfoClient`, `TcrmClient`). Используй найденные DTO и методы для определения цели зависимости.

7. Занеси все найденные URL в результирующий список `http_clients`. Этот список будет дополнен в шаге 3 данными из анализа кода.

### Шаг 3: Извлечение зависимостей

Для каждого типа зависимости выполнить поиск по соответствующим файлам и паттернам кода с учётом специфики стека.

### Шаг 4: Определение назначения зависимостей

1. Для каждой найденной зависимости:
   - Найти DTO, используемые в этом контексте
   - Проанализировать названия пакетов и сервисов
   - Прочитать комментарии к коду
   - Определить бизнес-цель зависимости

2. Зафиксировать назначение в формате: `{действие} {объект}` например:
   - "Хранение данных пользователей"
   - "Кэширование сессий"
   - "Отправка уведомлений о платежах"
   - "Получение профиля клиента из CRM"

### Шаг 5: Классификация Kafka топиков

1. Собрать все имена топиков (consumer и producer)
2. Определить владельца каждого топика по naming convention
3. Разделить на:
   - **Входящие зависимости**: чтение из топиков других систем
   - **Исходящее API**: запись в топики, принадлежащие исследуемой системе

### Шаг 6: Классификация предоставляемого API

1. Выделить все HTTP/gRPC endpoints
2. Классифицировать по типу доступа (public/internal/admin)
3. Зафиксировать порты и пути

## Формат результата

Результат анализа представляется в виде структурированного списка:

```yaml
dependencies:
  databases:
    - type: postgresql
      host: ${DB_HOST}
      port: 5432
      name: ${DB_NAME}
      purpose: "Хранение данных пользователей и заказов"
      
  redis:
    - host: ${REDIS_HOST}
      port: 6379
      purpose: "Кэширование пользовательских сессий"
      
  s3:
    - endpoint: ${S3_ENDPOINT}
      bucket: ${S3_BUCKET}
      purpose: "Хранение загруженных файлов документов"
      
  kafka:
    bootstrap_servers: ${KAFKA_BROKERS}
    consumes:  # Зависимости от других систем
      - topic: crm.customer-updated
        owner: crm
        group: ${CONSUMER_GROUP}
        purpose: "Получение обновлений данных клиентов из CRM"
        dto: CustomerUpdatedEvent
    produces:  # Предоставляемое API
      - topic: order-service.orders
        owner: order-service
        purpose: "События о создании и изменении заказов"
        dto: OrderEvent
        
  http_clients:  # Зависимости от других сервисов
    - name: auth-service
      url: ${AUTH_SERVICE_URL}
      type: REST
      purpose: "Валидация JWT токенов пользователей"
    - name: payment-gateway
      url: ${PAYMENT_GATEWAY_URL}
      type: REST
      purpose: "Проведение платежей по заказам"
    - name: crm-service
      url: ${CRM_SERVICE_URL}
      type: gRPC
      purpose: "Получение данных клиентов из CRM"
      
provided_api:
  rest:
    public:
      - path: /api/v1/*
        port: 8080
        purpose: "API для веб- и мобильных клиентов"
    internal:
      - path: /internal/*
        port: 8080
        purpose: "API для внутреннего взаимодействия сервисов"
    admin:
      - path: /admin/*
        port: 8080
        purpose: "Административное API для управления системой"
      - path: /actuator/*
        port: 8080
        purpose: "Health checks и метрики мониторинга"
  grpc:
    - service: OrderService
      port: 9090
      purpose: "gRPC API для работы с заказами"
  kafka:
    - topic: order-service.orders
      purpose: "События о создании и изменении заказов"
      dto: OrderEvent
      schema: Avro
```

## Инструменты поиска

- **grep_search**: Поиск по содержимому файлов с regex
- **glob**: Поиск файлов по маске
- **read_file**: Чтение конкретных файлов конфигурации
- **list_directory**: Обзор структуры проекта

## Примеры поисковых запросов по стекам

### Spring Boot

```
# Базы данных
pattern: "(jdbc:|@Configuration.*DataSource|spring\\.datasource)"

# Kafka
pattern: "(@KafkaListener|KafkaTemplate|spring\\.kafka)"

# REST контроллеры
pattern: "@(RestController|GetMapping|PostMapping|RequestMapping)"

# HTTP клиенты — явные в коде
pattern: "(@FeignClient|RestTemplate|WebClient|HttpClient)"

# HTTP клиенты — URL через @Value (инъекция напрямую в конструктор/поле)
pattern: "@Value\(\"\\$\{[^}]*(url|endpoint|host|base-url)[^}]*\}\"\)"

# HTTP клиенты из библиотек (стартеры) — искать в build.gradle / pom.xml
pattern: "[a-z-]+-client-spring-boot-starter"

# Чтение свойств через ConfigurationProperties (альтернатива @Value)
pattern: "@ConfigurationProperties"
```

### Scala + Akka

```
# Базы данных
pattern: "(jdbc|slick|doobie|application\\.conf.*jdbc)"

# Kafka
pattern: "(akka-kafka|Consumer\\.settings|Producer\\.settings)"

# HTTP routes
pattern: "(path\\(|get\\(|post\\(|akka\\.http)"

# HTTP клиенты
pattern: "(Http\\(\\)\\.singleRequest|akka-http-client)"
```

### Scala + cats.effect

```
# Базы данных
pattern: "(HikariDataSource|skunk\\.Session|doobie\\.Transactor)"

# Kafka
pattern: "(fs2-kafka|KafkaConsumer|KafkaProducer)"

# HTTP
pattern: "(http4s\\.Client|HttpRoutes|Router)"

# HTTP клиенты
pattern: "(sttp\\.backend|http4s\\.EmberClient)"
```

### Scala + ZIO

```
# Базы данных
pattern: "(zio\\.jdbc|JDBCConfig|HikariConfig)"

# Kafka
pattern: "(zio-kafka|Consumer\\.subscribe|Producer\\.produce)"

# HTTP
pattern: "(zio\\.http|Routes\\.|Http\\.)"

# HTTP клиенты
pattern: "(ZClient|HttpClient)"
```

### .NET

```
# Базы данных
pattern: "(ConnectionStrings|AddDbContext|EntityFramework)"

# Kafka
pattern: "(Confluent\\.Kafka|ConsumerConfig|ProducerConfig)"

# REST контроллеры
pattern: "(\\[ApiController\\]|\\[Route\\]|\\[HttpGet\\]|\\[HttpPost\\])"

# HTTP клиенты
pattern: "(HttpClient|IHttpClientFactory|AddHttpClient)"
```

### NodeJS

```
# Базы данных
pattern: "(sequelize|typeorm|mongoose|pg\\.Pool|prisma)"

# Kafka
pattern: "(kafkajs|Consumer|Producer|\\@nestjs/microservices)"

# REST контроллеры
pattern: "(app\\.get|app\\.post|router\\.get|@Controller|@Get)"

# HTTP клиенты
pattern: "(axios|node-fetch|undici|http\\.get)"
```

### Golang

```
# Базы данных
pattern: "(sql\\.Open|gorm\\.Open|pgx\\.Connect)"

# Kafka
pattern: "(sarama|confluent-kafka|NewConsumer|NewProducer)"

# REST контроллеры
pattern: "(http\\.HandleFunc|mux\\.Router|gin\\.Router|echo\\.Group)"

# HTTP клиенты
pattern: "(http\\.Client|http\\.NewRequest|grpc\\.Dial)"
```

## Примечания

- Переменные окружения `${VAR}` фиксировать как есть, не пытаться разрешать
- Обращать внимание на условные конфигурации для разных окружений (dev, stage, prod)
- Учитывать service discovery (имена сервисов вместо host:port)
- Для gRPC искать `.proto` файлы с определениями service
- **Всегда определять назначение зависимости** через анализ DTO, пакетов, сервисов и комментариев
- Приоритет определения назначения: комментарии → имена DTO → названия пакетов → названия сервисов
- **Spring Boot:** prod-конфиг (`configMap/prod/application.yml`) — исчерпывающий список всех HTTP-зависимостей. Анализ кода дополняет его, а не заменяет. Если URL есть в конфиге но нет явного клиента в коде — это клиент из библиотеки, зависимость всё равно нужно фиксировать
- **Spring Boot:** `@ConfigurationProperties` классы, биндящиеся к `*.url`/`*.endpoint` секциям — дополнительный способ найти URL-инъекции, когда не используется `@Value`
