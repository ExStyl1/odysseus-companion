# acp-sdk-session-methods

## AIDT

AIDT-8268

## Зачем

После обновления `@agentclientprotocol/sdk` до `0.21.0` два метода агента «стабилизированы» — из имён убран устаревший префикс `unstable_`: `unstable_listSessions → listSessions`, `unstable_resumeSession → resumeSession`. Встроенный агент (`NessyAgent`) продолжал реализовывать старые имена, из-за чего desktop и плагины (VS Code, IntelliJ), запрашивая `session/list` и `session/resume`, получали `-32601 Method not found`. Desktop скрывал локальные «canonical mirror» сессии и не мог получить список от провайдера — список сессий отображался пустым, хотя данные на диске целы.

Патч приводит реализацию агента (и тестовых моков) к актуальным именам SDK 0.21, восстанавливая получение списка сессий и их возобновление для всех клиентов.

Клиенты (desktop, VS Code, IntelliJ) уже используют корректные клиентские методы (`connection.listSessions()` / `session/list`), поэтому править их не требуется — затрагивается только серверная реализация агента.

## Файлы

- `packages/cli/src/acp-integration/acpAgent.ts` — переименование `unstable_listSessions → listSessions`, `unstable_resumeSession → resumeSession` и сопутствующие комментарии.
- `packages/cli/src/acp-integration/acpAgent.test.ts` — тесты методов (моки и вызовы под новыми именами).
- `packages/acp-bridge/src/internal/testUtils.ts` — тестовый мок агента `unstable_resumeSession → resumeSession`.
- `packages/acp-bridge/src/bridge.ts` — комментарий-ссылка `unstable_resumeSession → resumeSession`.
- `docs/fork-patches/acp-sdk-session-methods.md` — этот файл.
- `docs/fork-patches/README.md` — запись в реестре.

## Откат

1. Если `@agentclientprotocol/sdk` откатят на версию без стабилизации имён — вернуть в `NessyAgent` и тестовых моках имена `unstable_listSessions`/`unstable_resumeSession`.
2. Убрать маркеры `// [nessy-fork] acp-sdk-session-methods`, строку из реестра `docs/fork-patches/README.md` и этот файл, когда upstream примет эквивалентный фикс.

## Upstream

Не отправлен. Переименование приходит из upstream SDK, но адаптация встроенного агента — fork-работа до принятия эквивалента в upstream.