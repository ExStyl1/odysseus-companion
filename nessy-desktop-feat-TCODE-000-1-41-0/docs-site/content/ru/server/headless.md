# Headless Server

Headless server запускает полный agent runtime Nessy Desktop — sessions, workspaces, [sources](../sources/overview), [skills](../skills/overview), [statuses](../statuses/overview), [labels](../labels/overview) и [automations](../automations/overview) — без Electron shell. Clients говорят с ним по тому же WebSocket RPC contract, что и desktop app; основной headless client в v1 — [CLI](cli).

::: info v1 scope
Nessy Desktop v1 запускает headless server из checkout репозитория. Self-contained distribution directory (со своим Bun runtime и ресурсами) можно собрать локально через `bun run scripts/build-server.ts`, но distribution URL пока не опубликован, поэтому standalone installer (`scripts/install-server.sh`) остаётся спящим, а container images нет. Browser-facing web surfaces (`apps/webui`, `apps/viewer`) сохранены в репозитории, но не являются поддерживаемой v1-поверхностью. Session sharing в v1 выключен.
:::

## Prerequisites

- [Bun](https://bun.sh) v1.x
- Checkout репозитория с установленными зависимостями:

```bash
bun install --frozen-lockfile
```

## Запуск server

Сгенерируйте token и запустите entry point:

```bash
export NESSY_SERVER_TOKEN=$(bun run packages/server/src/index.ts --generate-token)
echo "$NESSY_SERVER_TOKEN"   # сохраните — clients должны предъявить ровно это значение

bun run packages/server/src/index.ts
```

`bun run server:start` из корня репозитория запускает тот же entry point; `bun run server:dev` дополнительно собирает bundles agent subprocess и включает debug logging.

**За proxy.** Bun читает `HTTP_PROXY` и `HTTPS_PROXY` только при запуске, поэтому server, запущенный из checkout с одной из них — так его запускает каждая команда на этой странице и команда `run` CLI, — отправляет через этот proxy и собственные requests к этой машине (local model, loopback endpoint). В таком случае server печатает на старте предупреждение `[proxy]`. Перед запуском экспортируйте `NO_PROXY=localhost,127.0.0.1,::1,[::1]` (плюс свои entries). Distribution, собранный через `bun run scripts/build-server.ts`, стартует через свой launcher `bin/nessy-server`, который добавляет эти entries сам.

На старте server печатает machine-parseable строки подключения — команда `run` CLI поднимает server именно так и читает их из stdout:

```
NESSY_SERVER_URL=ws://127.0.0.1:9100
NESSY_SERVER_TOKEN=<your-token>
```

### Требования к token

`NESSY_SERVER_TOKEN` обязателен; без него процесс сразу выходит. До приёма подключений token проверяется на очевидную слабость:

- короче **16 символов** → старт отклоняется (`Weak server token`)
- один повторяющийся символ (`aaaaaaaaaaaaaaaa`) → отклоняется
- меньше 8 различных символов → допускается, но логируется low-entropy warning

`--generate-token` печатает 48-символьную hex-строку (192 бита случайности) и выходит — удобный источник соответствующих tokens. `openssl rand -hex 32` работает не хуже. Clients с любым другим значением отклоняются на WebSocket handshake с `AUTH_FAILED`.

## Binding и TLS

По умолчанию server слушает `127.0.0.1:9100`. Задайте `NESSY_RPC_HOST` и `NESSY_RPC_PORT`, чтобы это изменить; port `0` берёт свободный ephemeral port (его используют self-spawned servers CLI).

Binding на не-localhost адрес **без TLS отклоняется** — token шёл бы по сети в открытом виде. Либо настройте TLS, либо — только для явно доверенных сетей — передайте `--allow-insecure-bind`, чтобы обойти guard (печатается warning).

TLS включается предоставлением и сертификата, и ключа; server тогда слушает `wss://`:

```bash
NESSY_SERVER_TOKEN=$NESSY_SERVER_TOKEN \
NESSY_RPC_HOST=0.0.0.0 \
NESSY_RPC_TLS_CERT=certs/cert.pem \
NESSY_RPC_TLS_KEY=certs/key.pem \
bun run packages/server/src/index.ts
```

Задать только один из `NESSY_RPC_TLS_CERT` / `NESSY_RPC_TLS_KEY` — startup error. `NESSY_RPC_TLS_CA` опционально задаёт CA chain.

Для локальной разработки создайте self-signed пару (действует 365 дней, пишется в `./certs/` по умолчанию):

```bash
./scripts/generate-dev-cert.sh
```

Clients тогда нужен CA через `--tls-ca` / `NESSY_TLS_CA`. Для production используйте сертификаты настоящего CA или терминируйте TLS на reverse proxy и держите server на localhost.

**На loopback-bind server принимает в заголовке `Host` только собственную authority.** WebSocket-upgrade, чей `Host` не равен `127.0.0.1:<port>`, `localhost:<port>` или `[::1]:<port>`, отклоняется с `403 Forbidden: unexpected Host header`; запрос вообще без `Host` тоже отклоняется. Это стандартная защита от страницы в чьём-то браузере, направленной на server, который слушает только для вас: такая страница обязана назвать ваш port, чтобы вообще до него дойти, и браузер тогда ставит ваш port рядом с хостом атакующего. Все клиенты, которые поставляет этот продукт, были измерены заранее и проходят.

Проверка включена для loopback-bind и молчит на любом другом bind, где браузер законно называет публичный хост. Единственный законный способ встретить этот отказ — reverse proxy перед loopback-bind, который пробрасывает публичное имя (широко копируемое `proxy_set_header Host $host` из nginx): задайте `NESSY_RPC_ALLOWED_UPGRADE_HOSTS` равным той authority, которую предъявляет ваш proxy, — через запятую, каждая запись ровно в том виде, в каком она приходит (`agent.corp.example` или `agent.corp.example:443`). Сам отказ называет эту переменную в логе server. Deployment, который отдаёт web UI, свой адрес там перечислять не обязан: server сам засевает список той authority, которую уже выдал браузеру.

## Environment Variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `NESSY_SERVER_TOKEN` | yes | — | bearer token, который должны предъявить clients (16+ символов) |
| `NESSY_RPC_HOST` | no | `127.0.0.1` | bind-адрес; не-локальные значения требуют TLS |
| `NESSY_RPC_PORT` | no | `9100` | bind port; `0` = ephemeral |
| `NESSY_RPC_TLS_CERT` | with key | — | PEM-сертификат; включает `wss://` |
| `NESSY_RPC_TLS_KEY` | with cert | — | PEM private key |
| `NESSY_RPC_TLS_CA` | no | — | PEM CA chain |
| `NESSY_RPC_ALLOWED_UPGRADE_HOSTS` | no | — | дополнительные authority в `Host`, принимаемые на WebSocket-upgrade, через запятую; для reverse proxy перед loopback-bind |
| `NESSY_DEBUG` | no | off | `true`/`1` включает debug logging |
| `NESSY_SAFE_MODE` | no | off | `1` стартует sessions в safe mode: instructions files, skills, plugins, hooks, MCP servers, commands и agents не загружаются; managed policy продолжает действовать |
| `NESSY_CONFIG_DIR` | no | `~/.nessy-agent` | `CONFIG_DIR`; задайте для параллельных изолированных инстансов |
| `NESSY_HEALTH_PORT` | no | off | при > 0 отдаёт `GET /health` на этом port, на RPC-bind; вне loopback — за bearer |
| `NESSY_BUNDLED_ASSETS_ROOT` | no | repo root | корень bundled assets в packaged builds |
| `NESSY_APP_ROOT` | no | cwd | override пути app root |
| `NESSY_RESOURCES_PATH` | no | `cwd/resources` | override пути resources |
| `NESSY_IS_PACKAGED` | no | `false` | `true` помечает packaged production build |
| `NESSY_VERSION` | no | package version | строка версии в handshake |
| `NESSY_WEBUI_DIR` | no | — | путь к собранным web UI assets (спящая поверхность, см. ниже) |
| `NESSY_WEBUI_PASSWORD` | no | server token | отдельный, более короткий пароль для web login |
| `NESSY_WEBUI_SECURE_COOKIE` | no | auto | принудительно вкл/выкл флаг `Secure` session cookie |
| `NESSY_WEBUI_WS_URL` | no | derived | browser-facing `ws://`/`wss://` URL из `/api/config` |
Имена переменных сохраняют upstream-префикс `NESSY_` — этот префикс в форке является замороженным compatibility contract. Client-side переменные (`NESSY_SERVER_URL`, `NESSY_SERVER_TOKEN`, `NESSY_TLS_CA`) описаны в [Справочнике CLI](../reference/cli#environment-variables); app-wide список — в [Environment Variables](../reference/config/environment-variables).

**Файлы `.env`.** Bun сам загружает файлы `.env` при запуске — `.env`, `.env.local` и варианты по `NODE_ENV`, в порядке, который приводит [документация Bun](https://bun.com/docs/runtime/environment-variables), — и читает их из каталога, в котором запущен server (для службы systemd или launchd — из её `WorkingDirectory`), а не из родительского каталога. Переменная, уже заданная в окружении запуска, сохраняет своё значение. Так работает каждый запуск на этой странице, и так же работает launcher `bin/nessy-server` у distribution, собранного через `bun run scripts/build-server.ts`: он запускает свой bundled Bun без `--no-env-file` и не меняет каталог, поэтому собственный `.env` distribution читается, только если server запущен из каталога distribution. Это оставлено намеренно — каталог запуска выбирает оператор, — но server, запущенный внутри другого репозитория, берёт и `.env` этого репозитория (proxy, ключ, настройку `NESSY_*`). Чтобы этого избежать, запускайте server из каталога, файлы `.env` в котором вы контролируете, или, из checkout, отключите загрузку собственным переключателем Bun:

```bash
bun --no-env-file run packages/server/src/index.ts
```

Аргументы после `bin/nessy-server` передаются server, а не Bun, поэтому `bin/nessy-server --no-env-file` загрузку не отключает. Файл, указанный через `--env-file`, загружается и при `--no-env-file`. То же касается `bunfig.toml`: Bun читает его из каталога, в котором запущен server, и скрипт, указанный в его `preload`, выполняется внутри server раньше собственной точки входа server. `--no-env-file` этого не отключает, поэтому server, запущенный внутри другого репозитория, выполняет и preload из `bunfig.toml` этого репозитория. Это тоже намеренно оставлено на Bun; чтобы этого избежать, запускайте server из каталога, который вы контролируете. Если `NESSY_SERVER_TOKEN` не задан, `install.sh` distribution записывает сгенерированный token в собственный `.env` distribution, а устанавливаемый им unit systemd запускает server из этого каталога с этим файлом в качестве `EnvironmentFile`.

## Data Directory и Locking

`CONFIG_DIR` равен `NESSY_CONFIG_DIR`, если переменная задана, иначе `~/.nessy-agent`:

```
CONFIG_DIR/
  config.json
  credentials.enc
  recent-projects.json
  sessions/<workspace-id>/<session-id>/
  workspaces/<workspace-id>/
  plugins/
  .server.lock
```

Конфигурация и ресурсы Workspace живут в `workspaces/<workspace-id>`;
sessions — глобальные partitions, ключуемые тем же immutable `workspaceId`.
`recent-projects.json` — backend-owned история external Projects. Его opaque
handles и identity hints перепроверяются перед использованием и никогда не
дают trust.

`CONFIG_DIR/.server.lock` обеспечивает один server на config directory: второй
старт против той же директории падает с `Another server instance is already
running (PID …)`. Locks мёртвых процессов или предыдущей загрузки распознаются
и перезаписываются автоматически; если crash оставил действительно stale lock,
удалите файл и повторите.

Чтобы запускать несколько servers бок о бок, дайте каждому свой
`NESSY_CONFIG_DIR`.

Старт требует storage layout v2 до открытия порта. Только подходящий legacy
default home переименовывается same-parent в
`.nessy-agent.legacy-v1.<transactionId>`; он никогда не импортируется, не
читается как runtime state и не удаляется автоматически. Legacy
пользовательский `NESSY_CONFIG_DIR` блокирует запуск нетронутым. Бэкапьте весь
`CONFIG_DIR`; external Projects и `~/.agents` требуют отдельных backups.

## Managed Settings и Network Trust

Headless server применяет те же managed settings, что и desktop app, включая
server-delivered layer, получаемый с Nessy Gateway: delivery cache периодически
обновляется во время активного использования, а policy, требующая свежего
fetch, может держать запуск до успешного gateway sign-in. App-level
[настройки network proxy и TLS trust](../reference/config/network-proxy)
(proxy routing, bundled/system certificate stores, custom и managed CA,
mutual TLS) действуют и для headless hosts и их agent subprocesses.

## Health Endpoint

Для load balancers и probes задайте `NESSY_HEALTH_PORT` положительным номером порта. Server тогда отвечает на `GET /health` по plain HTTP payload-ом здоровья — статус 200 когда healthy, иначе 503. По умолчанию endpoint выключен.

**Он слушает тот же интерфейс, что и RPC server** (`NESSY_RPC_HOST`, по умолчанию `127.0.0.1`), а не все интерфейсы. На loopback-bind probe открыт, как и раньше. На любом другом bind он требует собственный bearer token сервера — значение, которое печатается как `NESSY_SERVER_TOKEN`:

```bash
curl -H "Authorization: Bearer $NESSY_SERVER_TOKEN" http://<rpc-host>:<health-port>/health
```

Без него запрос отвечает `401`. Любой путь кроме `/health` отвечает `404` на любом bind, как и раньше. Строка лога при старте называет интерфейс, который действительно был занят, и говорит, какой из двух случаев это.

## Web UI (спящий)

Server может встроить browser UI на RPC-порту, когда `NESSY_WEBUI_DIR` указывает на собранные assets:

```bash
bun run webui:build
NESSY_SERVER_TOKEN=$NESSY_SERVER_TOKEN NESSY_WEBUI_DIR=apps/webui/dist \
bun run packages/server/src/index.ts
```

`bun run server:prod` делает subprocess builds, сборку web UI и запуск одним шагом. Login использует `NESSY_WEBUI_PASSWORD` (fallback — server token) и выдаёт session cookie, которая принимается и на WebSocket upgrade.

::: warning
`apps/webui` — сохранённая, но спящая поверхность в Nessy Desktop v1 — она не валидируется в составе releases. Для headless-использования предпочитайте CLI.
:::

## Запуск при старте системы

### Linux (systemd)

Environment file, например `/opt/nessy-desktop/.env`:

```bash
NESSY_SERVER_TOKEN=<your-token>
NESSY_RPC_HOST=0.0.0.0
NESSY_RPC_PORT=9100
NESSY_RPC_TLS_CERT=/path/to/cert.pem
NESSY_RPC_TLS_KEY=/path/to/key.pem
```

Unit в `/etc/systemd/system/nessy-server.service`:

```ini
[Unit]
Description=Nessy Desktop headless server
After=network.target

[Service]
Type=simple
User=<your-user>
WorkingDirectory=/opt/nessy-desktop
EnvironmentFile=/opt/nessy-desktop/.env
ExecStart=/home/<your-user>/.bun/bin/bun run packages/server/src/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nessy-server
journalctl -u nessy-server -f
```

### macOS (launchd)

Plist в `~/Library/LaunchAgents/ru.nessy.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ru.nessy.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.bun/bin/bun</string>
    <string>run</string>
    <string>packages/server/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/nessy-desktop</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NESSY_SERVER_TOKEN</key>
    <string>YOUR_TOKEN</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/nessy-server.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/nessy-server.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/ru.nessy.server.plist
tail -f /tmp/nessy-server.log
launchctl unload ~/Library/LaunchAgents/ru.nessy.server.plist   # stop
```

## Remote Access

Не выставляйте WebSocket-порт в интернет напрямую. Разумные паттерны:

- **Reverse proxy** — держите `NESSY_RPC_HOST=127.0.0.1` и пусть nginx/Caddy терминирует TLS и форвардит WebSocket upgrades:

```nginx
server {
    listen 443 ssl;
    server_name nessy.example.internal;

    ssl_certificate     /etc/ssl/nessy/fullchain.pem;
    ssl_certificate_key /etc/ssl/nessy/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

- **SSH tunnel** — нулевая настройка на стороне server для ad-hoc доступа:

```bash
ssh -L 9100:localhost:9100 user@your-server
# затем подключайте clients к ws://localhost:9100
```

- **Private mesh VPN** — привяжите `NESSY_RPC_HOST` к адресу mesh-интерфейса, чтобы порт был достижим только внутри overlay network; шифрование берёт на себя mesh.

## Shutdown Behavior

На SIGINT или SIGTERM server отправляет подключённым clients push `server:shuttingDown`, ждёт около двух секунд, чтобы они успели среагировать, сбрасывает все sessions на диск, закрывает transport и освобождает lock file.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Server token is required` | `NESSY_SERVER_TOKEN` не задан | экспортируйте token (см. [Требования к token](#требования-к-token)) |
| `Weak server token: Token too short …` | token короче 16 символов | используйте `--generate-token` или `openssl rand -hex 32` |
| `Refusing to bind to a network address without TLS` | не-localhost `NESSY_RPC_HOST` без cert/key | настройте TLS или `--allow-insecure-bind` в доверенных сетях |
| `TLS requires both NESSY_RPC_TLS_CERT and NESSY_RPC_TLS_KEY` | задана только одна TLS-переменная | укажите оба пути |
| `Another server instance is already running (PID …)` | lock держит живой server в той же config dir | остановите тот server или используйте отдельный `NESSY_CONFIG_DIR`; удаляйте `CONFIG_DIR/.server.lock` только если он действительно stale |
| Clients падают с `AUTH_FAILED` | token mismatch | передайте client-у точный server token |
| Нужно больше деталей в логах | — | стартуйте с `NESSY_DEBUG=true` |

Client-side проблемы подключения — в [таблице troubleshooting Справочника CLI](../reference/cli#troubleshooting).
