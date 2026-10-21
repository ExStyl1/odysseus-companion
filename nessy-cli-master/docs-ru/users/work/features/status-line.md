# Status Line

> Отображение пользовательской информации в футере с помощью shell-команды.

Status line позволяет вам запускать shell-команду, вывод которой отображается в левой секции футера. Команда получает структурированный JSON-контекст через stdin, поэтому может отображать зависимую от сессии информацию, такую как текущая модель, использование токенов, git-ветка или всё, что вы можете заскриптовать.

```
Однострочный статус (режим утверждения по умолчанию — 1 строка):
┌─────────────────────────────────────────────────────────────────┐
│  user@host ~/project (main) ctx:34%   🔒 docker | Debug | 67%  │  ← status line
└─────────────────────────────────────────────────────────────────┘

Многострочный статус (до 2 строк — 2 строки):
┌─────────────────────────────────────────────────────────────────┐
│  user@host ~/project (main) ctx:34%   🔒 docker | Debug | 67%  │  ← status line 1
│  ████████░░░░░░░░░░ 34% context                                │  ← status line 2
└─────────────────────────────────────────────────────────────────┘

Многострочный статус + режим не по умолчанию (3 строки макс):
┌─────────────────────────────────────────────────────────────────┐
│  user@host ~/project (main) ctx:34%   🔒 docker | Debug | 67%  │  ← status line 1
│  ████████░░░░░░░░░░ 34% context                                │  ← status line 2
│  auto-accept edits (shift + tab to cycle)                       │  ← индикатор режима
└─────────────────────────────────────────────────────────────────┘
```

Когда настроено, status line заменяет подсказку "? for shortcuts" по умолчанию. Сообщения с высоким приоритетом (подсказки выхода Ctrl+C/D, Esc, vim INSERT режим) временно переопределяют status line. Текст status line обрезается по доступной ширине.

## Предварительные требования

- [`jq`](https://jqlang.github.io/jq/) рекомендуется для парсинга JSON-входа (установите через `brew install jq`, `apt install jq` и т.д.)
- Простые команды, которые не нуждаются в JSON-данных (например, `git branch --show-current`), работают без `jq`

## Быстрая настройка

## Режим preset

### Конфигурация

Preset собирает строку из встроенных элементов без внешнего скрипта.

### Доступные элементы preset

Доступны модель, токены и контекст, каталог, Git-ветка, изменения файлов,
длительность и стоимость, если она сообщается провайдером.

### Пример вывода

Preset обновляется вместе с состоянием сессии и использует текущую тему.

### Настройка через диалог

В диалоге можно выбрать элементы и их порядок с немедленным предпросмотром.

## Режим command

Простейший способ настроить status line — команда `/statusline`. Она запускает агент настройки, который читает вашу shell PS1-конфигурацию и генерирует соответствующую status line:

```
/statusline
```

Вы также можете дать ему специфические инструкции:

```
/statusline show model name and context usage percentage
```

## Ручная конфигурация

Добавьте объект `statusLine` под ключ `ui` в `~/.nessy/settings.json`:

```json
{
  "ui": {
    "statusLine": {
      "type": "command",
      "command": "input=$(cat); model=$(echo \"$input\" | jq -r '.model.display_name'); pct=$(echo \"$input\" | jq -r '.context_window.used_percentage'); echo \"$model  ctx:${pct}%\""
    }
  }
}
```

| Поле              | Тип         | Обязательно | Описание                                                                                                                                    |
| ----------------- | ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`            | `"command"` | Да          | Должно быть `"command"`                                                                                                                     |
| `command`         | string      | Да          | Shell-команда для выполнения. Получает JSON через stdin, stdout отображается (до 2 строк).                                                  |
| `refreshInterval` | number      | Нет         | Перезапускать команду каждые N секунд (минимум 1). Полезно для данных, которые меняются без события состояния агента (часы, квота, аптайм). |

## JSON-вход

Команда получает JSON-объект через stdin со следующими полями:

```json
{
  "session_id": "abc-123",
  "version": "0.14.1",
  "model": {
    "display_name": "nessy-3-235b"
  },
  "context_window": {
    "context_window_size": 131072,
    "used_percentage": 34.3,
    "remaining_percentage": 65.7,
    "current_usage": 45000,
    "total_input_tokens": 30000,
    "total_output_tokens": 5000
  },
  "workspace": {
    "current_dir": "/home/user/project"
  },
  "git": {
    "branch": "main"
  },
  "metrics": {
    "models": {
      "nessy-3-235b": {
        "api": {
          "total_requests": 10,
          "total_errors": 0,
          "total_latency_ms": 5000
        },
        "tokens": {
          "prompt": 30000,
          "completion": 5000,
          "total": 35000,
          "cached": 10000,
          "thoughts": 2000
        }
      }
    },
    "files": {
      "total_lines_added": 120,
      "total_lines_removed": 30
    }
  },
  "vim": {
    "mode": "INSERT"
  }
}
```

| Поле                                  | Тип              | Описание                                                                                  |
| ------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `session_id`                          | string           | Уникальный идентификатор сессии                                                           |
| `version`                             | string           | Версия Nessy CLI                                                                          |
| `model.display_name`                  | string           | Имя текущей модели                                                                        |
| `context_window.context_window_size`  | number           | Полный размер контекстного окна в токенах                                                 |
| `context_window.used_percentage`      | number           | Использование контекстного окна в процентах (0–100)                                       |
| `context_window.remaining_percentage` | number           | Остаток контекстного окна в процентах (0–100)                                             |
| `context_window.current_usage`        | number           | Количество токенов из последнего API-вызова (текущий размер контекста)                    |
| `context_window.total_input_tokens`   | number           | Всего входных токенов потреблено в этой сессии                                            |
| `context_window.total_output_tokens`  | number           | Всего выходных токенов потреблено в этой сессии                                           |
| `workspace.current_dir`               | string           | Текущая рабочая директория                                                                |
| `git`                                 | object \| absent | Присутствует только внутри git-репозитория.                                               |
| `git.branch`                          | string           | Имя текущей ветки                                                                         |
| `metrics.models.<id>.api`             | object           | Статистика API на модель: `total_requests`, `total_errors`, `total_latency_ms`            |
| `metrics.models.<id>.tokens`          | object           | Использование токенов на модель: `prompt`, `completion`, `total`, `cached`, `thoughts`    |
| `metrics.files`                       | object           | Статистика изменений файлов: `total_lines_added`, `total_lines_removed`                   |
| `vim`                                 | object \| absent | Присутствует только когда включён vim-режим. Содержит `mode` (`"INSERT"` или `"NORMAL"`). |

> **Важно:** stdin может быть прочитан только один раз. Всегда сохраняйте его в переменную сначала: `input=$(cat)`.

## Примеры

### Модель и использование токенов

```json
{
  "ui": {
    "statusLine": {
      "type": "command",
      "command": "input=$(cat); model=$(echo \"$input\" | jq -r '.model.display_name'); pct=$(echo \"$input\" | jq -r '.context_window.used_percentage'); echo \"$model  ctx:${pct}%\""
    }
  }
}
```

Вывод: `nessy-3-235b  ctx:34%`

### Git-ветка + директория

```json
{
  "ui": {
    "statusLine": {
      "type": "command",
      "command": "input=$(cat); branch=$(echo \"$input\" | jq -r '.git.branch // empty'); dir=$(basename \"$(echo \"$input\" | jq -r '.workspace.current_dir')\"); echo \"$dir${branch:+ ($branch)}\""
    }
  }
}
```

Вывод: `my-project (main)`

> Заметка: Поле `git.branch` предоставляется напрямую в JSON-входе — нет необходимости вызывать `git` через shell.

### Статистика изменений файлов

```json
{
  "ui": {
    "statusLine": {
      "type": "command",
      "command": "input=$(cat); added=$(echo \"$input\" | jq -r '.metrics.files.total_lines_added'); removed=$(echo \"$input\" | jq -r '.metrics.files.total_lines_removed'); echo \"+$added/-$removed lines\""
    }
  }
}
```

Вывод: `+120/-30 lines`

### Живые часы и git-ветка

Используйте `refreshInterval`, когда status line показывает данные, которые меняются без события агента (например, часы, аптайм, счётчики rate-limit):

```json
{
  "ui": {
    "statusLine": {
      "type": "command",
      "command": "input=$(cat); branch=$(echo \"$input\" | jq -r '.git.branch // \"no-git\"'); echo \"$(date +%H:%M:%S)  ($branch)\"",
      "refreshInterval": 1
    }
  }
}
```

Вывод (обновляется каждую секунду): `14:32:07  (main)`

### Файл скрипта для сложных команд

Для более длинных команд сохраните файл скрипта в `~/.nessy/statusline-command.sh`:

```bash
#!/bin/bash
input=$(cat)
model=$(echo "$input" | jq -r '.model.display_name')
pct=$(echo "$input" | jq -r '.context_window.used_percentage')
branch=$(echo "$input" | jq -r '.git.branch // empty')
added=$(echo "$input" | jq -r '.metrics.files.total_lines_added')
removed=$(echo "$input" | jq -r '.metrics.files.total_lines_removed')

parts=()
[ -n "$model" ] && parts+=("$model")
[ -n "$branch" ] && parts+=("($branch)")
[ "$pct" != "0" ] 2>/dev/null && parts+=("ctx:${pct}%")
([ "$added" -gt 0 ] || [ "$removed" -gt 0 ]) 2>/dev/null && parts+=("+${added}/-${removed}")

echo "${parts[*]}"
```

Затем ссылку на него в настройках:

```json
{
  "ui": {
    "statusLine": {
      "type": "command",
      "command": "bash ~/.nessy/statusline-command.sh"
    }
  }
}
```

## Поведение

- **Триггеры обновления**: Status line обновляется, когда модель меняется, отправляется новое сообщение (изменяется количество токенов), переключается vim-режим, меняется git-ветка, завершаются вызовы инструментов или происходят изменения файлов. Обновления дебасируются (300 мс). Установите `refreshInterval` (секунды) для дополнительного перезапуска команды по таймеру — полезно для данных, которые меняются без события агента (часы, rate limits, статус сборки).
- **Таймаут**: Команды, которые занимают дольше 5 секунд, убиваются. Status line очищается при ошибке.
- **Вывод**: Поддерживается многострочный вывод (до 2 строк; лишние строки отбрасываются). Каждая строка рендерится как отдельная строка с затемнёнными цветами в левой секции футера. Строки, превышающие доступную ширину, обрезаются.
- **Hot reload**: Изменения в `ui.statusLine` в настройках вступают в силу немедленно — перезапуск не требуется.
- **Shell**: Команды выполняются через `/bin/sh` на macOS/Linux. На Windows по умолчанию используется `cmd.exe` — оборачивайте POSIX-команды с `bash -c "..."` или указывайте на bash-скрипт (например, `bash ~/.nessy/statusline-command.sh`).
- **Удаление**: Удалите ключ `ui.statusLine` из настроек для отключения. Подсказка "? for shortcuts" возвращается.

## Troubleshooting

| Проблема                    | Причина                     | Решение                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Status line не показывается | Конфиг на неправильном пути | Должно быть под `ui.statusLine`, не на корневом уровне `statusLine`                                                                                                                                                                                                                                                                                                                   |
| Пустой вывод                | Команда падает молча        | Протестируйте вручную: `echo '{"session_id":"test","version":"0.14.1","model":{"display_name":"test"},"context_window":{"context_window_size":0,"used_percentage":0,"remaining_percentage":100,"current_usage":0,"total_input_tokens":0,"total_output_tokens":0},"workspace":{"current_dir":"/tmp"},"metrics":{"models":{},"files":{"total_lines_added":0,"total_lines_removed":0}}}' | sh -c 'your_command'` |
| Устаревшие данные           | Триггер не сработал         | Отправьте сообщение или переключите модель для триггера обновления — или установите `refreshInterval` для перезапуска команды по таймеру                                                                                                                                                                                                                                              |
| Команда слишком медленная   | Сложный скрипт              | Оптимизируйте скрипт или переместите тяжёлую работу в фоновый кэш                                                                                                                                                                                                                                                                                                                     |
