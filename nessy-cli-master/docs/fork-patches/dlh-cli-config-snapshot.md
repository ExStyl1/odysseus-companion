# dlh-cli-config-snapshot

## AIDT

-

## Зачем

Отливаем в DLH событие `cli_config` — снапшот текущего инвентаря
инструментов (основная модель, approval mode, core-tools, список MCP-серверов
с состоянием и найденные MCP-инструменты). Это позволяет на дашбордах
смотреть фактически доступный агенту инструментарий на старте сессии и при
изменении MCP-набора, а не только статичную конфигурацию.

- Снапшот эмитится на старте сессии (`logToolsSnapshot`), при повторной
  инициализации и после `setTools()`.
- При изменении набора MCP-клиентов (connect / disconnect / disable) события
  переотливаются через подписку `subscribeDlhMcpUpdates()` с дебаунсом
  1500 мс. Подписка создаётся в `Config.initialize()` после создания реестра
  инструментов: в конструкторе реестр ещё недоступен.
- Дополнительно отливается `session_ended` на штатном завершении, чтобы по
  отсутствию события отличать аварийно оборванные сессии.

## Файлы

- `packages/core/src/config/config.ts` — вызовы `logToolsSnapshot()` при
  старте/ре-инициализации и после MCP discovery, `logSessionEnd()` на
  shutdown, подписка `subscribeDlhMcpUpdates()`.
- `packages/core/src/config/config.test.ts` — порядок инициализации подписки
  и отправка снапшота после изменений MCP.
- `packages/core/src/telemetry/nessy-dlh/nessy-dlh.ts` — payload-типы
  `CliConfigPayload` / `SessionEndedPayload`, `buildCliConfigPayload()`,
  публичные методы `logToolsSnapshot()` / `logSessionEnd()` и их
  DLH-обработчики.
- `packages/core/src/telemetry/nessy-dlh/cli-config.test.ts` — тесты
  `logToolsSnapshot` / `logSessionEnd`.
- `packages/core/src/tools/mcp-client-manager.ts` — `onToolsChange()`
  подписка на `mcp-client-update`.

Кодовые точки помечены `// [nessy-fork] dlh-cli-config-snapshot`.

## Откат

1. Убрать вызовы `logToolsSnapshot()` и `logSessionEnd()` из `config.ts`
   и метод `subscribeDlhMcpUpdates()`.
2. Удалить `onToolsChange()` из `mcp-client-manager.ts`.
3. Удалить `CliConfigPayload` / `SessionEndedPayload`, `buildCliConfigPayload()`,
   методы `logToolsSnapshot()` / `logSessionEnd()` и их обработчики из
   `nessy-dlh.ts`.
4. Удалить `cli-config.test.ts`.
5. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Upstream

Не отправлен. Внутренняя телеметрия Tinkoff/T-Bank.
