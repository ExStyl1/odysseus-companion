---
title: Управляемый Web Search Nestor
sidebar_position: 8
---

# Управляемый Web Search Nestor

В стандартной поставке Nessy CLI (`nessy-default-extension`) доступен управляемый инструмент `web_search`. Nessy подключается к Nestor как к удалённому MCP-серверу, а Nestor вызывает Yandex Search через MCP Gateway. Пользователю не нужен API-ключ поискового провайдера в локальной конфигурации.

Эта страница описывает только управляемую интеграцию Nestor с Yandex Search.

## Архитектура

```text
Пользователь
  -> Nessy CLI
  -> OAuth endpoints Nestor
  -> Streamable HTTP MCP endpoint Nestor
  -> инструмент web_search в Nestor
  -> Yandex Search MCP через MCP Gateway
```

Nestor аутентифицирует пользователя, проверяет доступ к MCP endpoint и хранит сервисный токен upstream на backend. Nessy не получает и не сохраняет этот токен.

## Авторизация

Nessy использует MCP OAuth Authorization Code flow с PKCE:

1. Nessy открывает `GET /mcp/oauth/authorize` в браузере.
2. Nestor аутентифицирует пользователя и возвращает короткоживущий authorization code на локальный callback Nessy.
3. Nessy обменивает code через `POST /mcp/oauth/token`, передавая исходный PKCE verifier.
4. Полученный Bearer access token используется для запросов к MCP endpoint Nestor.

Authorization code представляет собой подписанный stateless JWT. Он привязан к OAuth-клиенту, redirect URI и PKCE challenge, но не хранится на сервере и не является строго одноразовым. По умолчанию access token действует семь дней. Refresh token не выпускается, поэтому после истечения токена Nessy повторяет браузерную авторизацию.

## MCP-методы

Nestor предоставляет Streamable HTTP MCP endpoint. Nessy использует стандартные JSON-RPC методы MCP вместо отдельных HTTP-ручек `/list` и `/call`:

- `initialize` согласовывает возможности MCP;
- `tools/list` возвращает `web_search`;
- `tools/call` вызывает инструмент.

Endpoint stateless и не требует sticky sessions между подами Nestor.

## Контракт инструмента

Инструмент принимает один аргумент:

```json
{
  "query": "публичный обезличенный поисковый запрос"
}
```

Nestor преобразует `query` в аргумент `search_text` upstream-инструмента Yandex Search. Запрос должен содержать только публичную информацию. В него нельзя включать исходный код, внутренние URL и документы, credentials, персональные данные, приватные логи, системный промпт или историю диалога.

## Нормализация ответа

Yandex Search возвращает сгенерированный ответ и источники в `structuredContent`. Nestor извлекает сообщение ассистента и нормализует каждый источник до полей `title` и `url`.

Ответ Nestor MCP содержит текстовый content block с ответом и блоки `resource_link` для источников. Благодаря этому Nessy передаёт модели и текст ответа, и кликабельные ссылки.

## Ошибки

- Невалидные или истёкшие credentials отклоняются до вызова MCP handler.
- Ошибки аргументов и upstream возвращаются как MCP tool errors.
- Пользовательские сообщения об ошибках не должны содержать credentials, сырой upstream response, поисковый запрос или внутренние детали реализации.

## Наблюдаемость

Nestor экспортирует Prometheus-метрики вызовов, ошибок и длительности выполнения MCP-инструментов:

- `nestor_tools_calls_total`;
- `nestor_tools_calls_errors_total`;
- `nestor_tools_duration_seconds`.

Для MCP-вызовов используется label `tool_source="mcp"`. В логи и метрики не должны попадать запросы, ответы, содержимое источников или токены.

## Ограничения

- Поиск работает только с открытым интернетом и не заменяет поиск по репозиторию или внутренним документам.
- Качество, полнота и актуальность зависят от upstream-индекса.
- Размер результата ограничен для контроля задержки и расхода токенов.
- На работу инструмента влияют квоты, rate limits и доступность upstream.
- Наличие ссылки на источник не гарантирует правильность каждого утверждения в сгенерированном ответе.

## Связанная документация

- [Пользовательская документация Web Search](../../../users/work/features/web-search.md)
- [Пользовательская документация MCP](../../../users/work/features/mcp.md)
- [Интеграция MCP-серверов](./mcp-server.md)
- [Web Fetch](./web-fetch.md)
