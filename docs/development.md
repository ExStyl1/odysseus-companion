# Работа с кодом Odysseus

## Где что находится

`tools/` содержит стабильные команды. Внутренняя логика разделена по назначению:

- `tools/personal/` — хранение, модели, учётные данные и перенос чатов.
- `tools/profile/` — подключение проектов и синхронизация общих ресурсов.
- `tools/knowledge/` — каталоги знаний, ручные записи, чтение источников, проекции графа, кэш и индексатор Python.
- `tools/cli/` — применение оформления CLI.
- `tools/skills/` — подготовка описаний и правил выбора навыков.

В `tests/` используются те же разделы: `personal`, `profile`, `knowledge`, `cli`, `skills`, `integration`. Python-проверки Graphify лежат в `tests/knowledge/test_knowledge.py` и запускаются вместе с общей проверкой, когда установлен движок Graphify.

`integrations/cli/settings.json` хранит штатные настройки баннера и палитр CLI. В `integrations/catalog/` лежит HTML-шаблон справочника навыков.

Шаблоны Desktop повторяют структуру нативного приложения:

```text
integrations/desktop/
├── manifest.json
├── main/                         Главный процесс и запуск терминала
├── shared/                       Типы обмена между процессами
├── renderer/
│   ├── components/knowledge/     Карта, раскладка и движение указателя
│   ├── components/plugins/       Каталог навыков
│   ├── components/icons/         Брендинг
│   ├── lib/                      Работа с данными интерфейса
│   └── data/                     Сгенерированные описания навыков
└── assets/                       Тема, изображения и иконки
```

`manifest.json` связывает каждый шаблон с файлом приложения. В нём отдельно описаны точечные изменения upstream, текстовые шаблоны и бинарные ресурсы.

## Как вносить изменения

При работе с картой правьте компонент в `integrations/desktop/renderer/components/knowledge/`. Раскладка находится в `knowledge-layout.ts`, обработка движения — в `knowledge-pan.ts`. Работа с файлами, графом и пользовательскими записями выполняется за пределами renderer, в `tools/knowledge/`.

При изменении дополнения Desktop обновляйте шаблон и его нативную копию, указанную в manifest. Для новой версии исходников сначала выполните `npm run desktop:integration -- --check`, затем примените без `--check`. Несовпадение существующего шаблона требует сверки изменений: установщик не заменяет его молча.

Для изменения навыков редактируйте исходные данные в `shared/skills-catalog.json` и `shared/ui/`. Команда `npm run catalog:build` обновляет справочники, описания и контрольные суммы. JSON в `integrations/desktop/renderer/data/` — результат генерации.

Исходники CLI и Desktop хранятся отдельно от интеграции. Их расположение задаёт `odysseus.json`. Не переносите установленные зависимости и сборки ради изменения дополнения: нативные проекты сохраняют свои команды сборки и обновления.

## Стабильные точки входа

Команды `tools/odysseus.mjs`, `run-component.mjs`, `graphify.mjs`, `knowledge-ui.mjs`, `knowledge-obsidian-sync.mjs`, `personal-sync.mjs` и `personal-worker.mjs` сохраняют пути. Их используют уже созданные источники MCP, Desktop и терминальные сеансы.

В `tools/personal-store.mjs`, `tools/personal-secrets.mjs` и `tools/knowledge_projects.py` оставлены короткие совместимые переходы к новым модулям. Они нужны для ранее собранных приложений и работающих процессов. В новом коде импортируйте реализации из соответствующих подпапок.

Ручные записи и пользовательские пояснения графа хранятся отдельно от автоматического индекса. Состояние, резервные копии и секреты не относятся к исходному коду; их расположение описано в инструкциях по синхронизации и Graphify.

## Проверки

Все проверки интеграции:

```bash
npm test
npm run desktop:integration -- --check
npm run sync -- --check
```

Один раздел:

```bash
node --test tests/knowledge/*.test.mjs
node --test tests/personal/*.test.mjs
```

Изменения Desktop дополнительно проверяются нативными тестами, typecheck и сборкой соответствующего компонента по его `AGENTS.md`. Две нативные кодовые базы не входят в корневую команду `npm test` целиком.

Форматирование собственного кода задают `.editorconfig` и `.prettierrc.json`. `.prettierignore` исключает исходники upstream, общий импортированный каталог, рабочие данные и сгенерированные JSON. Python-байткод не хранится в Git.

## First-run setup

`tools/setup/` contains discovery, bundle-data reading, private profile import and ownership validation. `npm run setup -- --check` previews discovery without writing. See [migration behavior](first-run-ru.md).
