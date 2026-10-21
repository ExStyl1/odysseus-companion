---
name: "whiteboard"
description: "Создание архитектурных схем, связей и макетов интерфейса на корпоративной доске Whiteboard."
trigger: "Когда нужно создать визуальную диаграмму, схему архитектуры, roadmap, UI-мокап или любую другую визуализацию"
when: ["Нужно нарисовать архитектурную диаграмму по описанию","Требуется визуализировать связи между компонентами","Нужно создать UI-мокап или wireframe","Требуется экспортировать диаграмму в PNG для презентации","Нужно быстро набросать схему по текстовому описанию"]
tags: ["whiteboard","diagram","architecture","visualization","unidraw"]
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

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


# Whiteboard Skill

Генерация диаграмм и схем по промпту. Поддерживает JSON и natural language описания.

## Возможности

- **Генерация по промпту** — одна команда создаёт полную диаграмму из текстового описания
- **Любые типы связей** — прямые, кривые, ортогональные линии с наконечниками
- **Авто-раскладка** — горизонтальная, вертикальная, grid
- **Экспорт в PNG** — рендеринг в изображение для презентаций
- **Цветовые палитры** — предустановленные цвета для типов элементов

## Быстрый старт

### Экспорт в PNG

```bash
python3 scripts/main.py export png architecture.png --file architecture.unidraw
```

## Команды

### draw — Генерация диаграммы из описания

```bash
python3 scripts/main.py draw "<описание>" --output <файл>
```

**Параметры:**
- `description` — описание диаграммы (JSON или natural language)
- `--file` — файл с описанием (вместо description в аргументе)
- `--output, -o` — выходной файл (.unidraw)
- `--width` — ширина холста (по умолчанию 2000)
- `--height` — высота холста (по умолчанию 1500)
- `--auto-size` — автоматически подогнать размер холста

**Примеры:**

```bash

# Из файла
python3 scripts/main.py draw --file diagram.txt --output arch.unidraw

# С авто-размером
python3 scripts/main.py draw "a -> b : link" --auto-size --output test.unidraw
```

### create — Создать пустую whiteboard

```bash
python3 scripts/main.py create <name> --width 2000 --height 1500
```

### add-node — Добавить узел

```bash
python3 scripts/main.py add-node "<label>" <x> <y> --file <файл> [опции]
```

**Параметры:**
- `label` — текст узла
- `x, y` — координаты
- `--id` — ID узла (для связей)
- `--shape` — форма: `rectangle`, `rounded`, `circle`, `diamond`, `cylinder`
- `--width` — ширина (по умолчанию 180)
- `--height` — высота (по умолчанию 80)
- `--color` — палитра: `blue`, `green`, `yellow`, `purple`, `red`, `gray`
- `--bold` — жирный текст

**Пример:**

```bash
python3 scripts/main.py add-node "Frontend" 100 100 \
  --id frontend --shape rounded --color blue --file diagram.unidraw
```

### connect — Добавить связь

```bash
python3 scripts/main.py connect <source> <target> --file <файл> [опции]
```

**Параметры:**
- `source` — ID исходного узла
- `target` — ID целевого узла
- `--label` — подпись связи
- `--line-type` — тип: `straight`, `curved`, `orthogonal`
- `--line-style` — стиль: `s` (solid), `do` (dotted), `da` (dashed)
- `--line-width` — толщина (по умолчанию 2)
- `--line-color` — цвет hex (по умолчанию #3A3A3A)
- `--arrow-start` — наконечник на начале: `none`, `arrow`, `triangle`, `diamond`, `circle`
- `--arrow-end` — наконечник на конце
- `--source-anchor` — привязка источника: `north`, `south`, `east`, `west`, `center`
- `--target-anchor` — привязка цели

**Пример:**

```bash
# Прямая стрелка
python3 scripts/main.py connect frontend backend \
  --label "REST API" --arrow-end arrow --file arch.unidraw

# Пунктирная связь
python3 scripts/main.py connect service1 service2 \
  --line-style da --arrow-end arrow --file arch.unidraw

# Ортогональная линия
python3 scripts/main.py connect gateway db \
  --line-type orthogonal --file arch.unidraw
```

### add-text — Добавить текст

```bash
python3 scripts/main.py add-text "<текст>" <x> <y> --file <файл> [опции]
```

**Параметры:**
- `text` — текст
- `x, y` — координаты
- `--width` — ширина блока (по умолчанию 400)
- `--height` — высота (по умолчанию 40)
- `--color` — цвет текста
- `--font-size` — размер шрифта (по умолчанию 20)
- `--align` — выравнивание: `l`, `c`, `r`, `m`
- `--bold` — жирный текст

### layout — Применить раскладку

```bash
python3 scripts/main.py layout <тип> --elements "id1,id2,id3" --file <файл> [опции]
```

**Параметры:**
- `layout` — тип: `horizontal`, `vertical`, `grid`
- `--elements` — список ID через запятую
- `--x` — начальная X (по умолчанию 50)
- `--y` — начальная Y (по умолчанию 100)
- `--spacing` — отступ (по умолчанию 50)
- `--cols` — количество колонок для grid (по умолчанию 3)

**Пример:**

```bash
python3 scripts/main.py layout horizontal \
  --elements "user,frontend,backend,db" \
  --spacing 80 --file diagram.unidraw
```

### list — Показать элементы

```bash
python3 scripts/main.py list <файл>
```

### load — Загрузить и вывести JSON

```bash
python3 scripts/main.py load <файл>
```

### export — Экспорт

```bash
python3 scripts/main.py export <format> <output> --file <файл>
```

**Форматы:** `png`, `json`

## Форматы описания диаграмм

### JSON формат

```json
{
  "nodes": [
    {"id": "user", "label": "User", "x": 50, "y": 100, "shape": "3", "color": "green"},
    {"id": "frontend", "label": "Frontend", "x": 250, "y": 100, "shape": "2", "color": "blue"},
    {"id": "backend", "label": "Backend", "x": 450, "y": 100, "shape": "2", "color": "blue"},
    {"id": "db", "label": "Database", "x": 650, "y": 100, "shape": "8", "color": "purple"}
  ],
  "edges": [
    {"source": "user", "target": "frontend", "label": "uses", "arrowEnd": "arrow"},
    {"source": "frontend", "target": "backend", "label": "API call", "arrowEnd": "arrow"},
    {"source": "backend", "target": "db", "label": "CRUD", "arrowEnd": "arrow"}
  ]
}
```

### Natural Language

Простые фразы на естественном языке:

```
"создай пользователя и фронтенд, соедини их"
"user connected to frontend"
"frontend links backend"
```

## Типы элементов

| Тип | Форма | Код | Пример использования |
|-----|-------|-----|---------------------|
| Rectangle | Прямоугольник | 1 | Контейнеры, блоки |
| Rounded | Скруглённый | 2 | Компоненты, сервисы |
| Circle | Круг | 3 | Пользователи, актёры |
| Diamond | Ромб | 5 | Решения, очереди |
| Cylinder | Цилиндр | 8 | Базы данных, хранилища |

## Цветовые палитры

| Палитра | Fill | Stroke | Text |
|---------|------|--------|------|
| blue | #dbeafe | #2563eb | #1e40af |
| green | #d1fae5 | #059669 | #065f46 |
| yellow | #fef3c7 | #d97706 | #92400e |
| purple | #e9d5ff | #9333ea | #6b21a8 |
| red | #fee2e2 | #dc2626 | #991b1b |
| gray | #f3f4f6 | #6b7280 | #374151 |

## Типы связей

### Line Type

- `straight` — прямая линия
- `curved` — кривая Безье
- `orthogonal` — ортогональная (прямоугольная)

### Line Style

- `s` — solid (сплошная)
- `do` — dotted (точками)
- `da` — dashed (пунктир)

### Arrow Heads

- `none` — без наконечника
- `arrow` — открытая стрелка
- `triangle` — заполненный треугольник
- `diamond` — ромб (агрегация)
- `circle` — круг (композиция)

### Anchors

Точки привязки к элементу:
- `north` — верх
- `south` — низ
- `east` — право
- `west` — лево
- `center` — центр

## Примеры

### Микросервисная архитектура

```bash
python3 scripts/main.py draw "
  client((Client))
  lb [Load Balancer]
  api1 [API Service 1]
  api2 [API Service 2]
  cache [[Redis]]
  db1 [(PostgreSQL)]
  db2 [(MongoDB)]
  
  client -> lb : requests
  lb -> api1 : route
  lb -> api2 : route
  api1 -> cache : read
  api1 -> db1 : CRUD
  api2 -> db2 : CRUD
" --output microservices.unidraw --auto-size
```

### Sequence-диаграмма

```bash
python3 scripts/main.py draw "
  user((User))
  ui [UI]
  api [API]
  db [(DB)]
  
  user -> ui : click
  ui -> api : request
  api -> db : query
  db -> api : result
  api -> ui : response
  ui -> user : show
" --output sequence.unidraw --auto-size
```

### UI Wireframe

```bash
python3 scripts/main.py create wireframe --width 1200 --height 800

python3 scripts/main.py add-node "Header" 50 20 --shape rectangle --width 1100 --height 60 --file wireframe.unidraw
python3 scripts/main.py add-node "Sidebar" 50 100 --shape rectangle --width 200 --height 600 --file wireframe.unidraw
python3 scripts/main.py add-node "Main Content" 270 100 --shape rectangle --width 880 --height 600 --file wireframe.unidraw
python3 scripts/main.py add-node "Footer" 50 720 --shape rectangle --width 1100 --height 60 --file wireframe.unidraw
```

### Roadmap

```bash
python3 scripts/main.py draw "
  q1 [Q1 2026]
  q2 [Q2 2026]
  q3 [Q3 2026]
  q4 [Q4 2026]
  
  q1 -> q2 : 
  q2 -> q3 :
  q3 -> q4 :
" --output roadmap.unidraw

python3 scripts/main.py layout horizontal --elements "q1,q2,q3,q4" --spacing 30 --file roadmap.unidraw
```

## Зависимости

- Python 3.8+
- Pillow (`pip install Pillow`)

## Структура файлов

```
processes/meta/whiteboard/
├── SKILL.md                 # Эта документация
├── scripts/
│   ├── main.py              # CLI инструмент
│   ├── render_whiteboard.py # Рендеринг в PNG
│   └── lib/
│       └── whiteboard.py    # Библиотека
```

## Ограничения

- Экспорт в SVG/PDF пока не реализован
- Максимум ~100 элементов на одну диаграмму для производительности

## Советы

1. **Используйте `--auto-size`** для автоматической подгонки размера холста
2. **Давайте узлам понятные ID** для удобных связей
3. **Экспортируйте в PNG** перед презентациями
4. **Сохраняйте .unidraw файлы** в репозиторий как источник истины
