# Python SDK

## `nessy-cli-sdk`

`nessy-cli-sdk` — экспериментальный Python SDK для Nessy CLI. Версия 1 работает с существующим CLI-протоколом `stream-json` и сохраняет транспортный слой минимальным и тестируемым.

## Область применения

- Имя пакета: `nessy-cli-sdk`
- Путь импорта: `nessy_cli_sdk`
- Требование к среде выполнения: Python `>=3.10`
- Зависимость от CLI: внешний исполняемый файл `nessy` требуется в версии 1
- Область транспорта: только транспорт через процесс
- Не включено в версию 1: транспорт ACP, встроенные в SDK MCP-серверы

## Установка

```bash
pip install nessy-cli-sdk \
  -i https://artifactory.tcsbank.ru/artifactory/api/pypi/python-all/simple/
```

Для предварительных версий:

```bash
pip install --pre nessy-cli-sdk \
  -i https://artifactory.tcsbank.ru/artifactory/api/pypi/python-all/simple/
```

:::note
Пакет размещён во внутреннем PyPI-репозитории TCS. Если вы используете `.pip/pip.conf` или `PIP_INDEX_URL` для установки индекса по умолчанию, добавьте `artifactory.tcsbank.ru` в `trusted-host`.
:::

Если `nessy` отсутствует в `PATH`, передайте `path_to_nessy_executable` явно.

Перед написанием кода SDK убедитесь, что CLI работает в той же оболочке:

```bash
nessy --version
```

## Быстрый старт

```python
import asyncio

from nessy_cli_sdk import (
    is_sdk_assistant_message,
    is_sdk_result_message,
    query,
)


def extract_text(message):
    content = message.get("message", {}).get("content", [])
    if not isinstance(content, list):
        return repr(content)
    texts = [
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    return "".join(texts) if texts else "[no text content]"


def print_result(message):
    if message.get("is_error"):
        error = message.get("error") or {}
        print(f"Error: {error.get('message', 'Unknown error')}")
        return
    print(message.get("result", ""))


async def main() -> None:
    async with query(
        "Объясните структуру репозитория.",
        {
            "cwd": "/path/to/project",
            "path_to_nessy_executable": "nessy",
        },
    ) as result:
        async for message in result:
            if is_sdk_assistant_message(message):
                print(extract_text(message))
            elif is_sdk_result_message(message):
                print_result(message)


asyncio.run(main())
```

`asyncio.run()` подходит для автономных скриптов. Если ваше приложение уже запускает цикл событий, например `Jupyter`, `FastAPI` или `pytest-asyncio`, вызывайте `await main()` вместо этого.

## Синхронное использование

Используйте `query_sync`, когда ваше хост-приложение не является асинхронным:

```python
from nessy_cli_sdk import is_sdk_result_message, query_sync


with query_sync(
    "Обобщите этот репозиторий в одном абзаце.",
    {
        "cwd": "/path/to/project",
        "path_to_nessy_executable": "nessy",
    },
) as result:
    for message in result:
        if is_sdk_result_message(message):
            if message.get("is_error"):
                error = message.get("error") or {}
                print(f"Error: {error.get('message', 'Unknown error')}")
            else:
                print(message.get("result", ""))
```

## Поверхность API

### Точки входа верхнего уровня

- `query(prompt, `options`=`None`) -> Query`
- `query_sync(prompt, `options`=`None`) -> `SyncQuery``

`prompt` поддерживает:

- `str` для одноходовых запросов
- ``AsyncIterable`[SDKUserMessage]` для многоходовых потоков

### `Query`

- Асинхронный итератор по сообщениям SDK
- ``close`()`
- ``interrupt`()`
- `set_model(model)`
- `set_permission_mode(mode)`
- `supported_commands()`
- `mcp_server_status()`
- `get_session_id()`
- `is_closed()`

### `QueryOptions`

| Опция                      | Тип / значения                                          | Описание                                                                                                                                          |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                      | `str`                                                   | Рабочая директория для процесса CLI.                                                                                                              |
| `model`                    | `str`                                                   | Переопределение модели для этой сессии SDK.                                                                                                       |
| `path_to_nessy_executable` | `str`                                                   | `nessy`, явный путь к бинарному файлу или `.js`-пакет CLI.                                                                                        |
| `permission_mode`          | `default`, `plan`, `auto-edit`, `auto`                  | Режим одобрения выполнения инструментов. `auto` автоматически одобряет все инструменты; используйте только в доверенных или изолированных средах. |
| `can_use_tool`             | `async` `callback`                                      | Пользовательский `callback` одобрения для запросов инструментов.                                                                                  |
| `env`                      | `dict[str, str]`                                        | Дополнительные переменные окружения, передаваемые процессу CLI.                                                                                   |
| `system_prompt`            | `str`                                                   | Переопределение системного промпта.                                                                                                               |
| `append_system_prompt`     | `str`                                                   | Добавление дополнительных инструкций к системному промпту.                                                                                        |
| `debug`                    | `bool`                                                  | Перенаправление stderr CLI в stderr при отсутствии хука `stderr`.                                                                                 |
| `max_session_turns`        | `int`                                                   | Максимальное количество ходов перед завершением сессии CLI.                                                                                       |
| `core_tools`               | `list[str]`                                             | Ограничение доступного набора инструментов.                                                                                                       |
| `exclude_tools`            | `list[str]`                                             | Исключение подходящих инструментов.                                                                                                               |
| `allowed_tools`            | `list[str]`                                             | Разрешение подходящих инструментов без одобрения через `callback`.                                                                                |
| `auth_type`                | `openai`, `anthropic`, `dp-auth`, `gemini`, `vertex-ai` | Режим аутентификации, передаваемый в CLI.                                                                                                         |
| `include_partial_messages` | `bool`                                                  | Публикация частичных событий потока ассистента.                                                                                                   |
| `resume`                   | UUID string                                             | Возобновление известной сессии по идентификатору.                                                                                                 |
| `continue_session`         | `bool`                                                  | Продолжение последней сессии CLI.                                                                                                                 |
| `session_id`               | UUID string                                             | Запуск или корреляция сессии с известным идентификатором.                                                                                         |
| `timeout`                  | `mapping`                                               | Таймауты в секундах.                                                                                                                              |
| `stderr`                   | `callable`                                              | Получает строки stderr CLI.                                                                                                                       |

Используйте только одну из опций `resume`, `continue_session` или `session_id` в запросе. SDK вызывает `ValidationError`, если эти опции сессии комбинируются.

Не поддерживается в версии 1:

- `mcp_servers`

### Общая конфигурация

```python
options = {
    "cwd": "/path/to/project",
    "path_to_nessy_executable": "nessy",
    "model": "qwen-plus",
    "permission_mode": "plan",
    "max_session_turns": 1,
    "env": {
        "OPENAI_MODEL": "qwen-plus",
    },
    "timeout": {
        "control_request": 60,
        "can_use_tool": 60,
        "stream_close": 60,
    },
}
```

Значения таймаутов указываются в секундах. `env` объединяется с окружением родительского процесса, поэтому нужно передавать только те переменные, которые должны отличаться для этой сессии SDK. Устанавливайте секреты, такие как `OPENAI_API_KEY`, в окружении родительского процесса или менеджере секретов, а не жёстко кодируйте их в исходном коде.

## Обработка разрешений

Когда CLI публикует управляющий запрос `can_use_tool`, SDK маршрутизирует его через `can_use_tool(tool_name, tool_input, `context`)`.

- Поведение по умолчанию: отклонить
- Таймаут по умолчанию: 60 секунд, настраивается через ``timeout`.can_use_tool`
- Возврат при таймауте: отклонить
- Исключения `callback`: преобразуются в отклонение с сообщением об ошибке
- Контекст `callback`: `cancel_event`, `suggestions` и `blocked_path`
- Контракт `callback`: `can_use_tool` должен быть асинхронным с 3 позиционными аргументами; `stderr` должен принимать 1 позиционный строковый аргумент

Пример:

```python
import asyncio
from pathlib import Path

from nessy_cli_sdk import is_sdk_result_message, query

PROJECT_ROOT = Path("/path/to/project").resolve()


def project_path(tool_name, tool_input):
    key = "path" if tool_name == "list_directory" else "file_path"
    raw_path = tool_input.get(key)
    if not isinstance(raw_path, str) or not raw_path:
        return None

    resolved = (PROJECT_ROOT / raw_path).resolve()
    try:
        resolved.relative_to(PROJECT_ROOT)
    except ValueError:
        return None
    return resolved


async def can_use_tool(tool_name, tool_input, context):
    if tool_name in {"read_file", "list_directory", "write_file"}:
        resolved = project_path(tool_name, tool_input)
        if resolved is None:
            return {
                "behavior": "deny",
                "message": "Разрешены только пути в пределах проекта",
            }

        if tool_name == "write_file" and resolved.suffix != ".md":
            return {"behavior": "deny", "message": "Можно записывать только .md файлы"}

        return {"behavior": "allow", "updatedInput": tool_input}

    return {
        "behavior": "deny",
        "message": f"{tool_name} не разрешён этим приложением",
    }


async def main():
    async with query(
        "Обновите README.md кратким описанием.",
        {
            "cwd": str(PROJECT_ROOT),
            "path_to_nessy_executable": "nessy",
            "can_use_tool": can_use_tool,
        },
    ) as result:
        async for message in result:
            if is_sdk_result_message(message):
                if message.get("is_error"):
                    error = message.get("error") or {}
                    print(f"Error: {error.get('message', 'Unknown error')}")
                else:
                    print(message.get("result", ""))


asyncio.run(main())
```

Если вы не передаёте `can_use_tool`, SDK по умолчанию отклоняет запросы разрешений.

## Многоходовые сессии

Для многоходовых сессий передавайте асинхронный итерируемый объект объектов `SDKUserMessage`:

```python
import asyncio

from nessy_cli_sdk import SDKUserMessage, is_sdk_result_message, query

SESSION_ID = "123e4567-e89b-12d3-a456-426614174000"


async def prompts():
    first: SDKUserMessage = {
        "type": "user",
        "session_id": SESSION_ID,
        "message": {
            "role": "user",
            "content": "Создайте краткое описание проекта.",
        },
        "parent_tool_use_id": None,
    }
    yield first

    second: SDKUserMessage = {
        "type": "user",
        "session_id": SESSION_ID,
        "message": {
            "role": "user",
            "content": "Также перечислите тестовые файлы.",
        },
        "parent_tool_use_id": None,
    }
    yield second


async def main():
    async with query(
        prompts(),
        {
            "cwd": "/path/to/project",
            "path_to_nessy_executable": "nessy",
            "session_id": SESSION_ID,
        },
    ) as result:
        async for message in result:
            if is_sdk_result_message(message):
                if message.get("is_error"):
                    error = message.get("error") or {}
                    print(f"Error: {error.get('message', 'Unknown error')}")
                else:
                    print(message.get("result", ""))


asyncio.run(main())
```

Все сообщения в асинхронном итерируемом объекте должны быть известны заранее. SDK отправляет их последовательно в CLI, но не может передать предыдущий ответ обратно в генератор. Если вам нужен диалоговый режим с поочерёдными ходами, управляйте каждым ходом как отдельным вызовом `query()`.

## Управление выполнением

Возвращаемый объект `Query` может управлять запущенным процессом CLI:

```python
import asyncio

from nessy_cli_sdk import is_sdk_result_message, query


async def main():
    async with query(
        "Изучите этот репозиторий и объясните структуру тестов.",
        {
            "cwd": "/path/to/project",
            "path_to_nessy_executable": "nessy",
        },
    ) as result:
        commands = await result.supported_commands()
        print(commands)

        await result.set_permission_mode("plan")
        await result.set_model("qwen-plus")

        async for message in result:
            if is_sdk_result_message(message):
                if message.get("is_error"):
                    error = message.get("error") or {}
                    print(f"Error: {error.get('message', 'Unknown error')}")
                else:
                    print(message.get("result", ""))


asyncio.run(main())
```

Используйте ``interrupt`()` для отмены текущей операции, ``close`()` для очистки базового процесса и `get_session_id()` для сохранения идентификатора сессии для последующего использования.

## Возобновление сессии

```python
import asyncio

from nessy_cli_sdk import is_sdk_result_message, query


async def main():
    # Возобновление известной сессии по идентификатору.
    async with query(
        "Продолжить с этой сессии.",
        {
            "path_to_nessy_executable": "nessy",
            "resume": "123e4567-e89b-12d3-a456-426614174000",
        },
    ) as known:
        async for message in known:
            if is_sdk_result_message(message):
                if message.get("is_error"):
                    error = message.get("error") or {}
                    print(f"Error: {error.get('message', 'Unknown error')}")
                else:
                    print(message.get("result", ""))


asyncio.run(main())
```

Чтобы продолжить последнюю сессию вместо этого:

```python
import asyncio

from nessy_cli_sdk import is_sdk_result_message, query


async def main():
    async with query(
        "Продолжить последнюю сессию.",
        {
            "path_to_nessy_executable": "nessy",
            "continue_session": True,
        },
    ) as latest:
        async for message in latest:
            if is_sdk_result_message(message):
                if message.get("is_error"):
                    error = message.get("error") or {}
                    print(f"Error: {error.get('message', 'Unknown error')}")
                else:
                    print(message.get("result", ""))


asyncio.run(main())
```

`resume` полезен, когда ваше приложение хранит идентификаторы сессий. `continue_session` делегирует выбор последней сессии CLI.

## Модель ошибок

- `ValidationError`: недопустимые опции, недопустимые UUID, неподдерживаемые комбинации
- `ControlRequestTimeoutError`: инициализация, прерывание или другой управляющий запрос превысили таймаут
- `ProcessExitError`: CLI завершился с ненулевым кодом
- `AbortError`: управляющий запрос или сессия были отменены

```python
from nessy_cli_sdk import (
    ProcessExitError,
    ValidationError,
    is_sdk_result_message,
    query_sync,
)

try:
    with query_sync("Сказать привет", {"path_to_nessy_executable": "nessy"}) as result:
        for message in result:
            if is_sdk_result_message(message):
                if message.get("is_error"):
                    error = message.get("error") or {}
                    print(f"Error: {error.get('message', 'Unknown error')}")
                else:
                    print(message.get("result", ""))
except ValidationError as exc:
    print(f"Недопустимые опции SDK: {exc}")
except ProcessExitError as exc:
    print(f"nessy завершился с {exc.exit_code}: {exc}")
```

## Устранение неполадок

Если SDK не может запустить CLI:

- Убедитесь, что `nessy --`version`` работает в целевой среде
- Передайте `path_to_nessy_executable`, если ваша оболочка использует `nvm`, `pyenv` или другую нестандартную настройку PATH
- Используйте `debug=True` или `stderr=print` для отображения stderr CLI при отладке

Если вызовы управления сессией превышают таймаут:

- Убедитесь, что целевая версия `nessy` поддерживает `--input-format stream-json`
- Увеличьте `timeout.control_request`
- Убедитесь, что ни один скрипт-обёртка не поглощает stdout/stderr

## Интеграция с репозиторием

Вспомогательные команды уровня репозитория:

- `npm run test:sdk:python`
- `npm run lint:sdk:python`
- `npm run typecheck:sdk:python`
- `npm run smoke:sdk:python -- --nessy nessy`

## Реальное E2E-тестирование

Для реальной проверки выполнения (фактический процесс `nessy` + реальный вызов модели) запустите из корня репозитория. NPM-хелпер использует `python3`, поэтому убедитесь, что он ссылается на интерпретатор Python `>=3.10`:

```bash
npm run smoke:sdk:python -- --nessy nessy
```

Этот скрипт запускает:

- асинхронный одноходовой запрос
- асинхронный управляющий поток (`supported_commands`, обновления режима разрешений)
- синхронный запрос `query_sync`

Он выводит JSON и возвращает ненулевой код при неудаче.
