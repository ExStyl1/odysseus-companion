# acp-elicitation-ask-user-question

## AIDT

AIDT-8203

## Зачем

Upstream nessy-cli отображал `ask_user_question` только через legacy `session/request_permission` с вопросами, вложенными в `toolCall.rawInput`. Форк переводит вопросы на стандартный ACP `elicitation/create` (form mode) для клиентов, объявивших `clientCapabilities.elicitation.form` (Desktop, VS Code, IntelliJ, Web Shell через daemon bridge), с fallback на legacy permission для остальных.

Заодно закрыты два пробела интеграции, которые ломали вопросы на конкретных клиентах:

- **IntelliJ** читал `questions` только из top-level `request.questions`, тогда как CLI шлёт их в `toolCall.rawInput.questions` (legacy-путь) — из-за этого в webview уходил пустой payload и `AskUserQuestionDialog` падал на `questions.length`, пустея целиком.
- **Webui/Web Shell** нормализовали только `permission_request`; `elicitation_request` попадал в `default`-ветку как `debug`-блок и не доходил до UI. Добавлены типы событий `elicitation.request`/`elicitation.resolved`, блок транскрипта `kind: 'elicitation'`, хук `usePendingElicitation` и действие `respondToElicitation`, а bridge публикует `elicitation_resolved` после ответа, чтобы блок помечался resolved.

В Desktop-рендере поток `elicitation_resolved` доведён до конца: `SessionManager` (Desktop RPC-путь) эмитит `elicitation_resolved` после ответа, event-processor превращает его в эффект, а `App` дропает из `pendingElicitations` форму, отвеченную извне (карточкой питомца) — иначе чат-форма оставалась открытой. Дроп по `requestId` (не `slice(1)`), чтобы невыбранная follow-up форма не терялась после того, как `*_resolved` уже убрал запись. Симметричный `permission_resolved` для permission-вопросов относится к патчу `desktop-pet-session-aggregation`.

## Файлы

Полный перечень изменённых относительно `master` файлов:

- `package.json`, `package-lock.json`, `packages/cli/package.json`, `packages/acp-bridge/package.json`, `packages/channels/base/package.json`, `packages/vscode-ide-companion/package.json` — bump `@agentclientprotocol/sdk` → `^0.21.0` (API elicitation).
- `packages/acp-bridge/src/bridge.ts` — `respondToElicitation`/`respondToSessionElicitation`, публикация `elicitation_resolved`.
- `packages/acp-bridge/src/bridgeClient.ts` — публикация `elicitation_request` в session bus и ожидание ответа.
- `packages/acp-bridge/src/bridgeTypes.ts` — типы `respondToElicitation`/`respondToSessionElicitation`.
- `packages/acp-bridge/src/daemonEventTypes.ts` — константы `elicitation_request`/`elicitation_resolved`.
- `packages/channels/base/src/AcpBridge.ts` — проброс elicitation через base-канал.
- `packages/cli/src/acp-integration/acpAgent.ts` — передача `clientCapabilities` в Session.
- `packages/cli/src/acp-integration/service/filesystem.ts` — мелочи elicitation.
- `packages/cli/src/acp-integration/session/Session.ts` и `Session.test.ts` — выбор `unstable_createElicitation` при `elicitation.form`, конвертация schema → ответы, fallback на `requestPermission`.
- `packages/cli/src/acp-integration/session/SubAgentTracker.ts` — мелочи elicitation для суб-агентов.
- `packages/cli/src/acp-integration/session/permissionUtils.ts` и `permissionUtils.test.ts` — построение elicitation schema, `elicitationContentToAnswers`, `resolveAskUserQuestionOptionId`.
- `packages/cli/src/serve/acp-http/connection-registry.ts` — регистрация pending elicitation.
- `packages/cli/src/serve/acp-http/dispatch.ts` — доставка `elicitation_request` в SSE.
- `packages/cli/src/serve/server.ts` — ответ по `POST /session/:id/elicitation/:requestId`.
- `packages/desktop/apps/electron/src/renderer/App.tsx` — подключение elicitation-обработчика; дроп формы из `pendingElicitations` по `requestId` на `elicitation_resolved`.
- `packages/desktop/apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx` — показ elicitation-формы.
- `packages/desktop/apps/electron/src/renderer/components/app-shell/input/structured/AskUserQuestionRequest.tsx` — рендер и клавиатурная навигация формы.
- `packages/desktop/apps/electron/src/renderer/context/AppShellContext.tsx` — состояние elicitation.
- `packages/desktop/apps/electron/src/renderer/event-processor/handlers/session.ts`, `processor.ts`, `types.ts` — обработка `elicitation_request`; `handleElicitationResolved`/эффект `elicitation_resolved`/тип `ElicitationResolvedEvent`.
- `packages/desktop/apps/electron/src/renderer/pages/ChatPage.tsx` — подключение формы.
- `packages/desktop/apps/electron/src/renderer/playground/PlaygroundAppShellProvider.tsx` — фикстура elicitation.
- `packages/desktop/apps/electron/src/shared/types.ts` — тип elicitation-события.
- `packages/desktop/apps/electron/src/transport/channel-map.ts` — маршрутизация elicitation-каналов.
- `packages/desktop/packages/server-core/src/handlers/rpc/sessions.ts`, `session-manager-interface.ts`, `packages/desktop/packages/server-core/src/sessions/SessionManager.ts` — проброс elicitation через Desktop RPC; эмиссия `elicitation_resolved` после ответа.
- `packages/desktop/packages/shared/src/agent/__tests__/test-utils.ts`, `backend/types.ts`, `base-agent.ts`, `nessy-agent.ts`, `packages/desktop/packages/shared/src/protocol/channels.ts`, `dto.ts` — типы и агент elicitation.
- `packages/intellij-ide-companion/src/main/kotlin/org/nessy/intellij/acp/AcpConnection.kt`, `AcpProtocol.kt` — объявление `elicitation.form`, обработка elicitation.
- `packages/intellij-ide-companion/src/main/kotlin/org/nessy/intellij/NessyToolWindowPanel.kt` — чтение `questions` из top-level И `toolCall.rawInput`, перехват JS-ошибок webview.
- `packages/sdk-typescript/scripts/build.js` — сборка elicitation-типов.
- `packages/sdk-typescript/src/daemon/DaemonClient.ts`, `DaemonSessionClient.ts`, `packages/sdk-typescript/src/daemon/index.ts` — `respondToElicitation`.
- `packages/sdk-typescript/src/daemon/ui/types.ts`, `normalizer.ts`, `transcript.ts`, `store.ts`, `terminal.ts` + `test/unit/daemonUi.test.ts` — события и блок `elicitation` в транскрипте.
- `packages/sdk-typescript/src/index.ts` — экспорт elicitation-типов.
- `packages/vscode-ide-companion/src/services/acpConnection.ts` — объявление `elicitation.form`, рендер формы.
- `packages/vscode-ide-companion/src/services/daemonIdeConnection.ts` и `daemonIdeConnection.test.ts` — рендер elicitation-формы и ответ в daemon-режиме.
- `packages/web-shell/client/App.tsx` — рендер elicitation-формы через `AskUserQuestion` и ответ.
- `packages/web-shell/client/adapters/transcriptAdapter.test.ts` — фикстура транскрипта elicitation.
- `packages/webui/src/components/messages/AskUserQuestionDialog.tsx` — устойчивость к пустым/битым вопросам.
- `packages/webui/src/daemon-react-sdk.ts`, `packages/webui/src/daemon/index.ts` — экспорт `usePendingElicitation`.
- `packages/webui/src/daemon/session/DaemonSessionProvider.tsx`, `actions.ts`, `index.ts`, `selectors.ts`, `types.ts` — `usePendingElicitation`/`selectDaemonPendingElicitation`, действие `respondToElicitation`.
- `docs/fork-patches/acp-elicitation-ask-user-question.md` — этот файл.
- `docs/fork-patches/README.md` — запись в реестре.

## Откат

1. Вернуть маршрутизацию `ask_user_question` на legacy `session/request_permission` (`useElicitation = false`), убрать `buildElicitationRequestedSchema`/`elicitationContentToAnswers` из permission flow.
2. Откатить `@agentclientprotocol/sdk` на предыдущую версию без elicitation-API, если она ещё совместима.
3. Удалить публикацию `elicitation_request`/`elicitation_resolved` из bridge и SSE-доставку из dispatch/server.
4. Удалить события и блок `elicitation` из SDK транскрипта/нормалайзера, вернув `elicitation_request` в `default`-ветку.
5. Удалить `respondToElicitation` из DaemonClient/DaemonSessionClient и webui-действий, а также хук `usePendingElicitation`.
6. Убрать рендер elicitation-формы из Desktop/VS Code/IntelliJ/Web Shell.
7. Удалить маркеры `[nessy-fork] acp-elicitation-ask-user-question`, строку из реестра и этот файл.

## Upstream

Не отправлен. Elicitation-метод и capability входят в upstream ACP SDK, но маршрутизация `ask_user_question` и интеграция по клиентам (bridge, Desktop, VS Code, IntelliJ, Web Shell) — fork-работа.
