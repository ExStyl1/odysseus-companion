# dlh-launch-metadata

## AIDT
AIDT-7551

## Зачем
Добавляем передачу метаданных запуска Nessy CLI в DLH через поле `agent_params_json`:
- `launch_mode` — режим запуска (vscode, acp, sdk, ci, jetbrains, nessycowork, desktop, tui, nonInteractive)
- `channel` — канал распространения (VSCode, ACP, SDK, CI, JetBrains, NessyCoWork, desktop, qwarium)
- `ext_version` — версия клиента (Desktop, SDK, VS Code Plugin, JetBrains Plugin version и т.д.)

Это позволяет на дашбордах Proteus фильтровать метрики по типу клиента и версии, что критично для наблюдаемости Desktop и других расширений.

## Файлы
- `packages/core/src/config/config.ts` — поле `extVersion` в ConfigParameters и Config
- `packages/cli/src/config/config.ts` — флаг `--ext-version` и передача в Config
- `packages/cli/src/gemini.test.tsx` — тестовые данные
- `packages/core/src/telemetry/loggers.ts` — `buildAgentParamsJson()` с launch_mode, channel, ext_version
- `packages/core/src/telemetry/nessy-dlh/dlh-types.ts` — документация DlhAgentRequest
- `packages/desktop/packages/shared/src/agent/nessy-agent.ts` — передача `--ext-version=${CRAFT_AGENT_VERSION}` при запуске CLI
- `packages/vscode-ide-companion/src/services/acpConnection.ts` — передача `--ext-version` из package.json версии расширения

## Откат
1. Удалить поле `extVersion` из ConfigParameters и Config
2. Удалить флаг `--ext-version` из CLI
3. Удалить поля launch_mode, channel, ext_version из buildAgentParamsJson()
4. Удалить документацию из dlh-types.ts
5. Удалить этот файл fork-patch

## Upstream
Не отправлен. Внутренняя фича для наблюдаемости Desktop и расширений.
