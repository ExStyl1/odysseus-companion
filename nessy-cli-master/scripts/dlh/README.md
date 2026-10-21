# DLH Proxy - Локальный прокси для отладки DLH телеметрии

Python-скрипт для локального приёма и логирования событий DLH (Data Lake House) телеметрии.

## Запуск

**Базовый запуск:**

```bash
python3 scripts/dlh/proxy.py
```

Прокси запустится на `http://localhost:8080` и будет выводить события в консоль.

**Запуск в фоновом режиме:**

```bash
# macOS/Linux - запуск в фоне
python3 scripts/dlh/proxy.py &

# Или через nohup для работы после закрытия терминала
nohup python3 scripts/dlh/proxy.py > dlh-proxy.log 2>&1 &

# Windows PowerShell
Start-Process python3 -ArgumentList "scripts/dlh/proxy.py" -WindowStyle Hidden
```

**Остановка:**

```bash
# Найти процесс
ps aux | grep proxy.py

# Убить процесс
kill <PID>

# Или для фонового процесса
pkill -f proxy.py
```

## Что делает

- Слушает HTTP запросы на порту 8080
- Принимает JSON события от DLH клиента
- Фильтрует и выводит в консоль только ключевые поля
- Возвращает `{"status":"ok"}` клиенту

## Формат вывода

Для каждого типа события выводятся только указанные поля:

- **message**: message_id, session_id, prompt_id, role, content
- **request**: parent_prompt_id, prompt_id, session_id, agent_name, agent_hash, parent_tool_call_id
- **inference**: prompt, prompt_length, type, inference_id, prompt_id, session_id, prompt_text_length, model_response_length, model_id
- **tool_call**: tool_call_id, prompt_id, session_id, inference_id, function_name

## Пример вывода

```json
{
  "events": [
    {
      "type": "message",
      "data": {
        "message_id": "abc-123",
        "session_id": "sess-456",
        "prompt_id": "prompt-789",
        "role": "user",
        "content": "Привет!"
      }
    }
  ]
}
======================================================================
```

## Интеграция с Nessy CLI

**Запуск одной командой (с сохранением логов):**

```bash
# Прокси в фоне с логами в файл + Nessy CLI
> dlh-proxy.log && python3 scripts/dlh/proxy.py > dlh-proxy.log 2>&1 & export NESSY_DLG_PROXY=true && npm run dev

# Просмотр логов в другом терминале
tail -f dlh-proxy.log
```

**Или раздельно (рекомендуется для отладки):**

```bash
# Терминал 1 - прокси с выводом в консоль
python3 scripts/dlh/proxy.py

# Терминал 2 - Nessy CLI
export NESSY_DLG_PROXY=true && npm run dev
```

**Для направления DLH событий на локальный прокси, установите переменные окружения:**

```bash
# Включить режим локального прокси
export NESSY_DLG_PROXY=true

# Опционально: указать свой URL (по умолчанию http://localhost:8080)
export NESSY_DLG_PROXY_URL=http://localhost:8080
```

Или добавьте в `.env` файл проекта.

После этого все DLH события будут отправляться на локальный прокси вместо продакшен endpoint.

## Полный пример использования

**Шаг 1: Запустите прокси в отдельном терминале**

```bash
# Терминал 1 - запуск прокси
cd /path/to/nessy-cli
python3 scripts/dlh/proxy.py
```

Ожидаемый вывод:
```
Listening on http://0.0.0.0:8080
Press Ctrl+C to stop
```

**Шаг 2: Запустите Nessy CLI с включенным прокси**

```bash
# Терминал 2 - запуск Nessy CLI
cd /path/to/nessy-cli
export NESSY_DLG_PROXY=true
npm run dev
```

**Шаг 3: Наблюдайте за событиями**

В терминале с прокси вы увидите отфильтрованные события:

```json
{
  "events": [
    {
      "type": "request",
      "data": {
        "prompt_id": "session-123#agent-456#0",
        "session_id": "session-123",
        "agent_name": "managed-headless",
        "agent_hash": "abc123..."
      }
    }
  ]
}
======================================================================
```

**Шаг 4: Отладка конкретных событий**

Для отладки определённого типа событий можно использовать grep:

```bash
# Только сообщения
python3 scripts/dlh/proxy.py | grep '"type": "message"'

# Только tool calls
python3 scripts/dlh/proxy.py | grep '"type": "tool_call"'

# Сохранение в файл для анализа
python3 scripts/dlh/proxy.py > dlh-events.log 2>&1
```

**Шаг 5: Мониторинг логов**

Для просмотра логов в реальном времени используйте `tail`:

```bash
# Запуск прокси с сохранением логов
python3 scripts/dlh/proxy.py > dlh-proxy.log 2>&1 &

# Просмотр логов в реальном времени (в другом терминале)
tail -f dlh-proxy.log

# Просмотр последних 50 строк и продолжение мониторинга
tail -n 50 -f dlh-proxy.log

# Поиск по логам
grep '"type": "inference"' dlh-proxy.log
grep '"agent_name": "managed-headless"' dlh-proxy.log

# Подсчёт событий по типам
grep '"type":' dlh-proxy.log | sort | uniq -c
```

**Полезные команды для работы с логами:**

```bash
# Очистка лога
> dlh-proxy.log

# Просмотр с подсветкой JSON (если установлен jq)
tail -f dlh-proxy.log | jq .

# Разделение лога на части (каждые 1000 строк)
split -l 1000 dlh-proxy.log dlh-proxy-part-

# Поиск по времени (если добавить timestamp в proxy.py)
grep "2025-01-15" dlh-proxy.log
```

## Отладка

**Прокси не запускается:**

```bash
# Ошибка: Address already in use - порт 8080 занят

# Способ 1: Освободить порт (убить процесс)
lsof -ti :8080 | xargs kill -9

# Способ 2: Найти и убить вручную
lsof -i :8080
# Найти PID в выводе и выполнить: kill <PID>

# Способ 3: Использовать другой порт (измените в proxy.py строку 56)
# server = HTTPServer(("0.0.0.0", 9090), LoggingHandler)
# И обновите NESSY_DLG_PROXY_URL=http://localhost:9090
```

**События не приходят:**

```bash
# Проверьте, что переменная установлена
echo $NESSY_DLG_PROXY  # должно быть "true"

# Проверьте логи DLH клиента
export DEBUG=NESSY-DLH
npm run dev
```
