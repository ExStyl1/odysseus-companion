---
name: "ai-doc-generator"
description: "Генерация Markdown-документации Java/Kotlin Spring Boot по контроллерам, сервисам, конфигурации и интеграциям."
when: ["Необходимо создать документацию для существующего микросервиса","Нужно обновить документацию после изменений в коде","Требуется описать API и архитектуру сервиса для команды","Нужно подготовить документацию для передачи проекта","Сервис содержит Job'ы (планировщики) и требуется их документирование"]
triggers: ["сгенерируй документацию по коду","опиши архитектуру сервиса","создай документацию API","обнови документацию по микросервису","документируй контроллеры"]
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


# ai-doc-generator

Генератор технической документации для микросервисов на Java/Kotlin + Spring Boot с PlantUML-диаграммами

## Commands

1. `/ai-doc-generator` - запуск генератора документации
2. `/ai-doc-generator --full` - полная документация со всеми разделами
3. `/ai-doc-generator --api-only` - только API endpoint'ы
4. `/ai-doc-generator --architecture` - только архитектурный раздел
5. `/ai-doc-generator --jobs-only` - только Job'ы (планировщики)
6. `/ai-doc-generator --diff` - обновление по diff из MR (сравнивает изменения)
7. `/ai-doc-generator --check-undocumented` - проверка незадокументированных мест

## The Process

### Режимы работы

#### Режим 1: Полная генерация (--full или по умолчанию)
Генерирует документацию для всего проекта с нуля.

#### Режим 2: Инкрементальное обновление по diff (--diff)
Анализирует изменения из MR и обновляет только затронутые разделы документации.

#### Режим 3: Проверка незадокументированного (--check-undocumented)
Находит все незадокументированные контроллеры, endpoint'ы и Job'ы.

---

### Step 1: Анализ проекта (для всех режимов)
- Изучи структуру проекта (контроллеры, сервисы, репозитории, конфигурации, job'ы)
- Определи основные компоненты и их взаимодействие
- Выяви интеграции с внешними системами и БД
- Определи тип сервиса: API (REST) или Job-based (планировщик)
- Проверь наличие существующей документации в `ai-docs/`

### Step 2: Сбор информации (для всех режимов)
- Прочитай контроллеры для определения API endpoint'ов
- Найди job-классы (@Scheduled, @Job) для документирования планировщиков
- Проанализируй сервисы для понимания бизнес-логики
- Изучи репозитории и entity-классы для схемы данных
- Проверь конфигурационные файлы (application.yml, properties)
- Найди интеграции (REST-клиенты, Kafka, JDBC)

### Step 3: Определение режима работы

#### Если режим --diff (обновление по MR):
1. Получи diff изменений из MR (список изменённых файлов)
2. Определи тип изменений:
   - **Новый контроллер** → создать новую папку в `api/`
   - **Новый endpoint** → создать новый файл в папке контроллера
   - **Изменённый endpoint** → обновить существующий файл
   - **Удалённый endpoint** → пометить файл как устаревший (или удалить)
   - **Новый Job** → создать новую папку в `jobs/`
   - **Изменённый Job** → обновить существующий файл
   - **Изменения в entity** → обновить `data/schema.md`
   - **Изменения в сервисах** → обновить `architecture.md`
3. Для каждого изменённого файла:
   - Если документация уже существует → обновить её
   - Если документации нет → создать новую (как для незадокументированного)
4. Обнови навигацию в главном `README.md`

#### Если режим --full (полная генерация):
1. Создай полную структуру `ai-docs/`
2. Сгенерируй документацию для всех контроллеров, endpoint'ов и Job'ов
3. Создай `architecture.md` со всеми компонентами
4. Создай `data/schema.md` со всеми таблицами

#### Если режим --check-undocumented (проверка):
1. Просканируй все контроллеры и endpoint'ы
2. Просканируй все Job'ы
3. Сравни с существующей документацией в `ai-docs/`
4. Верни список незадокументированных элементов

### Step 4: Генерация документации

Создай структуру файлов в `ai-docs/` в корне проекта:

```
ai-docs/
├── README.md                    # Общая документация сервиса
├── architecture.md              # Архитектура с PlantUML-диаграммами
├── api/                         # API endpoint'ы (если есть)
│   └── <ControllerName>/
│       ├── README.md            # Список endpoint'ов контроллера
│       ├── <methodName>.md      # Документация endpoint'а
│       └── <methodName2>.md     # Другой endpoint
├── jobs/                        # Job'ы (если есть)
│   └── <JobClassName>/
│       ├── README.md            # Список Job'ов класса
│       └── <methodName>.md      # Документация Job'а
└── data/
    └── schema.md                # Схема данных
```

### Step 5: Логика для незадокументированных частей (режим --diff)

**Если часть кода ещё не была задокументирована:**

1. **Новый контроллер**:
   - Создать папку `ai-docs/api/<ControllerName>/`
   - Создать `README.md` контроллера со списком endpoint'ов
   - Создать файлы для каждого endpoint'а (`<methodName>.md`)

2. **Новый endpoint в существующем контроллере**:
   - Открыть `ai-docs/api/<ControllerName>/README.md`
   - Добавить новый endpoint в таблицу
   - Создать файл `ai-docs/api/<ControllerName>/<methodName>.md`

3. **Изменённый endpoint**:
   - Найти файл `ai-docs/api/<ControllerName>/<methodName>.md`
   - Обновить описание, параметры, примеры
   - Пересгенерировать sequence diagram

4. **Новый Job**:
   - Создать папку `ai-docs/jobs/<JobClassName>/`
   - Создать `README.md` класса со списком Job'ов
   - Создать файл для каждого метода Job'а

5. **Изменённая схема данных**:
   - Обновить `ai-docs/data/schema.md`
   - Добавить новые таблицы или изменить существующие

6. **Изменённая архитектура**:
   - Обновить `ai-docs/architecture.md`
   - Добавить новые компоненты или связи

### Формат файлов

#### README.md (главная страница)

Содержит:
- Краткое описание сервиса
- Основные возможности
- Навигацию по разделам
- Таблицы endpoint'ов и Job'ов с ссылками на файлы
- Интеграции и зависимости

#### architecture.md

Содержит PlantUML component diagram всех слоёв:
- Controller Layer
- Service Layer
- Repository Layer
- External (БД, внешние сервисы)

#### api/<ControllerName>/README.md

Содержит таблицу endpoint'ов контроллера с ссылками на файлы.

#### api/<ControllerName>/<methodName>.md

Содержит:
- Endpoint (метод, путь, описание)
- PlantUML Sequence Diagram
- Параметры запроса (Path, Query, Body)
- Примеры JSON запроса/ответа
- Коды ошибок

#### jobs/<JobClassName>/README.md

Содержит таблицу Job'ов класса с cron-расписанием.

#### jobs/<JobClassName>/<methodName>.md

Содержит:
- Job Information (тип, cron, описание)
- PlantUML Sequence Diagram
- PlantUML Activity Diagram
- Алгоритм работы
- Обработку ошибок
- Логирование и метрики

#### data/schema.md

Содержит PlantUML entity relationship диаграммы для всех БД.

## Dependencies

- Доступ к кодовой базе микросервиса
- Формат кода должен соответствовать стандартам Java/Kotlin + Spring Boot
- Наличие аннотаций Spring (@RestController, @Service, @Repository, @Scheduled)

## Output format

Структура Markdown-файлов с PlantUML-диаграммами:
- Component diagrams для архитектуры
- Sequence diagrams для endpoint'ов и Job'ов
- Activity diagrams для алгоритмов
- Entity relationship diagrams для схемы данных

## Internal structure

```
ai-doc-generator/
├── SKILL.md                 # Описание skill'а
├── README.md                # Подробная документация
├── template.md              # Шаблон главной страницы
├── examples.md              # Примеры сгенерированной документации
└── ai/
    └── task.md              # Детальный процесс генерации
```

## Best practices

- Перед генерацией убедитесь, что код соответствует naming conventions
- Проверяйте сгенерированную документацию на точность описания
- Обновляйте документацию при изменении API
- Используйте PlantUML для всех диаграмм
- Добавляйте примеры запросов/ответов для всех endpoint'ов
- Описывайте обработку ошибок и крайние случаи
- Группируйте endpoint'ы по контроллерам в папках
- Группируйте Job'ы по классам в папках
.
