# Odysseus Companion

Companion объединяет локальную базу знаний, сценарии и задачи. Приложение подключается к Nessy через MCP и открывает рабочие процессы корпоративного n8n.

На Mac с Apple Silicon установите [выпуск 0.8.9](https://github.com/ExStyl1/odysseus-companion/releases/tag/companion-v0.8.9):

```sh
( d=$(mktemp -d) && curl -fsSL https://github.com/ExStyl1/odysseus-companion/releases/download/companion-v0.8.9/install-companion.sh -o "$d/install-companion.sh" && sh "$d/install-companion.sh" --local-build )
```

Nessy устанавливается отдельно. Проверьте, что команда `nessy --version` работает в Терминале. Сборка Companion 0.8.9 подписана локально, macOS может заблокировать первый запуск.

Для сборки на macOS нужны Node.js 22+, npm и uv. Установите зависимости Nessy CLI, Electron и интерфейса Companion:

```sh
npm install --prefix nessy-cli-master
npm install --prefix companion
npm ci --prefix companion/frontend
npm run companion:build
```

Команда собирает автономную копию в `dist/companion`. Для зависимости uv можно указать путь через `ODYSSEUS_UV`. Если ваша установка Nessy использует закрытые npm пакеты, понадобится доступ к её реестру.

- `companion/` — Electron, интерфейс, навыки и справочник.
- `tools/companion/` — сервис, интеграция с Nessy, сборка и упаковка.
- `nessy-cli-master/` — исходники, используемые при сборке зависимостей MCP. Исполняемый Nessy CLI в приложение не входит.
- `shared/` — каталог навыков, используемый Companion.
