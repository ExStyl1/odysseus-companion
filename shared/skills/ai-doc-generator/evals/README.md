# Конфигурация тестов для ai-doc-generator

## Описание

Этот файл содержит конфигурацию для системы автоматического тестирования (evals) skill'а `ai-doc-generator`. Тесты проверяют корректность генерации технической документации в различных сценариях.

## Структура теста

Каждый тест состоит из:
- `id` - уникальный идентификатор теста
- `name` - краткое название теста
- `description` - описание того, что проверяет тест
- `prompt` - входной запрос для skill'а
- `expected_behavior` - ожидаемое поведение skill'а
- `setup` - (опционально) подготовка тестового окружения
- `validation` - (опционально) критерии валидации результата

## Тесты

```json
{
  "evals": [
    {
      "id": "basic-api-documentation",
      "name": "Базовая генерация документации API",
      "description": "Проверка возможности генерации документации для простого REST API микросервиса",
      "prompt": "сгенерируй документацию по коду для микросервиса управления пользователями",
      "expected_behavior": "Создаётся структура файлов в ai-docs/ с документацией API endpoint'ов, PlantUML-диаграммами и схемой данных",
      "validation": {
        "directory_created": "ai-docs/",
        "has_readme": true,
        "has_architecture": true,
        "has_api_folder": true,
        "plantuml_valid": true
      }
    },
    {
      "id": "job-documentation",
      "name": "Генерация документации Job'ов",
      "description": "Проверка документирования планировщиков (@Scheduled задачи)",
      "prompt": "документируй Job'ы для микросервиса фоновой обработки данных",
      "expected_behavior": "Создаются файлы документации для каждого Job'а с cron-расписанием, sequence diagram и activity diagram",
      "validation": {
        "jobs_folder_exists": true,
        "has_cron_expression": true,
        "has_sequence_diagram": true,
        "has_activity_diagram": true
      }
    },
    {
      "id": "plantuml-diagrams",
      "name": "Генерация PlantUML-диаграмм",
      "description": "Проверка корректности генерации PlantUML-диаграмм архитектуры и последовательности",
      "prompt": "опиши архитектуру сервиса с PlantUML-диаграммами",
      "expected_behavior": "Генерируются валидные PlantUML-диаграммы: component diagram для архитектуры, sequence diagram для endpoint'ов",
      "validation": {
        "component_diagram": true,
        "sequence_diagram": true,
        "plantuml_syntax_valid": true
      }
    },
    {
      "id": "controller-grouping",
      "name": "Группировка endpoint'ов по контроллерам",
      "description": "Проверка правильной группировки endpoint'ов в папках по контроллерам",
      "prompt": "создай документацию API с группировкой по контроллерам",
      "expected_behavior": "Каждый контроллер имеет свою папку в ai-docs/api/, endpoint'ы сгруппированы по методам",
      "validation": {
        "controller_folders": true,
        "readme_per_controller": true,
        "endpoint_files_correct": true
      }
    },
    {
      "id": "java-kotlin-support",
      "name": "Поддержка Java и Kotlin",
      "description": "Проверка корректной работы с Java и Kotlin проектами",
      "prompt": "сгенерируй документацию для Java/Spring Boot микросервиса",
      "expected_behavior": "Skill корректно распознаёт Java-классы и аннотации Spring, генерирует документацию аналогично Kotlin-проектам",
      "validation": {
        "java_classes_detected": true,
        "spring_annotations_recognized": true,
        "documentation_complete": true
      }
    },
    {
      "id": "complex-endpoint-description",
      "name": "Детальное описание endpoint'ов",
      "description": "Проверка полноты описания API endpoint'ов",
      "prompt": "документируй контроллеры с подробным описанием запросов и ответов",
      "expected_behavior": "Каждый endpoint содержит: параметры запроса, примеры JSON, коды ошибок, sequence diagram",
      "validation": {
        "request_params": true,
        "json_examples": true,
        "error_codes": true,
        "sequence_diagram": true
      }
    },
    {
      "id": "database-schema",
      "name": "Генерация схемы данных",
      "description": "Проверка генерации PlantUML-диаграммы схемы данных",
      "prompt": "опиши схему данных микросервиса",
      "expected_behavior": "Создаётся файл data/schema.md с PlantUML entity relationship диаграммой всех таблиц БД",
      "validation": {
        "schema_file_exists": true,
        "entity_relationship_diagram": true,
        "all_tables_documented": true
      }
    },
    {
      "id": "multi-controller-service",
      "name": "Документирование мультисервисной архитектуры",
      "description": "Проверка документирования сервиса с несколькими контроллерами и Job'ами",
      "prompt": "сгенерируй полную документацию для микросервиса с API и планировщиками",
      "expected_behavior": "Создаётся полная структура ai-docs/ с разделами api/, jobs/, data/, architecture.md",
      "validation": {
        "full_structure": true,
        "api_section": true,
        "jobs_section": true,
        "data_section": true,
        "architecture_md": true
      }
    }
  ]
}
```

## Запуск тестов

Для запуска тестов используется команда:

```
/ai-doc-generator --with-evals
```

Или запуск отдельных тестов:

```
/ai-doc-generator --eval basic-api-documentation
/ai-doc-generator --eval job-documentation
```

## Интерпретация результатов

Результаты тестов оцениваются по следующим критериям:

- **PASS** - Тест пройден успешно, все критерии валидации выполнены
- **FAIL** - Тест провален, один или несколько критериев не выполнены
- **PARTIAL** - Тест пройден частично, некоторые критерии выполнены
- **SKIP** - Тест пропущен (например, нет необходимых файлов в проекте)

## Критерии валидации

### Для API документации
- `directory_created` - папка `ai-docs/` создана
- `has_readme` - главный README.md существует
- `has_architecture` - файл architecture.md существует
- `has_api_folder` - папка api/ существует
- `plantuml_valid` - PlantUML-диаграммы корректны

### Для Job'ов
- `jobs_folder_exists` - папка jobs/ существует
- `has_cron_expression` - cron-выражения указаны
- `has_sequence_diagram` - sequence diagram присутствует
- `has_activity_diagram` - activity diagram присутствует

### Для группировки
- `controller_folders` - папки контроллеров созданы
- `readme_per_controller` - у каждого контроллера есть README
- `endpoint_files_correct` - файлы endpoint'ов названы корректно

### Для Java/Kotlin поддержки
- `java_classes_detected` - Java-классы распознаны
- `spring_annotations_recognized` - аннотации Spring распознаны
- `documentation_complete` - документация полная

## Добавление новых тестов

Для добавления новых тестов:

1. Определите сценарий, который нужно протестировать
2. Создайте уникальный идентификатор теста (kebab-case)
3. Опишите ожидаемое поведение skill'а
4. Добавьте критерии валидации (при необходимости)
5. Включите тест в массив `evals` в файле `evals.json`

## Пример добавления теста

```json
{
  "id": "error-handling-docs",
  "name": "Документирование обработки ошибок",
  "description": "Проверка описания кодов ошибок в документации endpoint'ов",
  "prompt": "документируй контроллер с описанием всех возможных ошибок",
  "expected_behavior": "Каждый endpoint содержит таблицу с кодами ошибок и их описанием",
  "validation": {
    "error_table_exists": true,
    "http_codes_documented": true,
    "error_descriptions": true
  }
}
```

## Интеграция с CI/CD

Тесты могут быть интегрированы в CI/CD пайплайн для автоматической проверки качества генерируемой документации при изменениях в коде микросервиса.
