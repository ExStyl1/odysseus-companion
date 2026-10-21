# ide-undici-agent

## AIDT

AIDT-7825

## Зачем

При создании локального HTTP-подключения к IDE MCP использовался
экспериментальный `EnvHttpProxyAgent`. Из-за этого при запуске TUI `undici`
выводил предупреждение `[UNDICI-EHPA]`, которое попадало в пользовательский
интерфейс.

Для локального IDE-сервера прокси не нужен, поэтому используем стабильный
`Agent`. Подключение остаётся прямым и не зависит от `HTTP_PROXY` или
`HTTPS_PROXY`.

## Файлы

- `packages/core/src/ide/ide-client.ts` — стабильный dispatcher для локального
  IDE MCP.
- `packages/core/src/ide/ide-client.test.ts` — регрессионная проверка dispatcher
  и параметров HTTP-запроса.
- `docs/fork-patches/README.md` — запись в реестре fork-патчей.
- `docs/fork-patches/ide-undici-agent.md` — описание fork-патча.

## Откат

Если upstream исключит экспериментальный `EnvHttpProxyAgent` из локального IDE
подключения:

1. Удалить fork-реализацию и маркер `[nessy-fork] ide-undici-agent`, сохранив
   эквивалентное upstream-поведение.
2. Адаптировать или удалить регрессионный тест, если его покрывает upstream.
3. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен.
