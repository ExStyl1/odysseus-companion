# Network Proxy

Nessy Desktop может отправлять outbound traffic через HTTP или HTTPS proxy —
это полезно в corporate networks, где proxy обязателен, или в любых сетях, где
firewall блокирует прямые подключения.

## Конфигурация

Откройте **Settings → App → Network** и задайте:

| Field                              | Description                                                          | Example                             |
| ---------------------------------- | -------------------------------------------------------------------- | ----------------------------------- |
| **Enable proxy**                   | Turn proxy routing on or off                                         | —                                   |
| **Использовать встроенный CA T-Bank** | Доверять встроенному corporate CA для Node-запросов                 | Включено                            |
| **Пользовательский CA-сертификат** | Абсолютный PEM-путь к другому corporate CA                           | `/path/to/corporate-ca.pem`         |
| **HTTP proxy**                     | Proxy URL for HTTP requests                                          | `http://proxy.corp.com:8080`        |
| **HTTPS proxy**                    | Proxy URL for HTTPS requests (falls back to the HTTP proxy if unset) | `http://proxy.corp.com:8080`        |
| **No proxy**                       | Comma-separated hosts/domains to bypass                              | `localhost,127.0.0.1,.internal.com` |

Settings хранятся в [config file](config-file) под key `networkProxy`:

```json
{
  "networkProxy": {
    "enabled": true,
    "httpProxy": "http://proxy.corp.com:8080",
    "httpsProxy": "http://proxy.corp.com:8080",
    "noProxy": "localhost,127.0.0.1,.internal.com",
    "tlsCaPath": "/path/to/corporate-ca.pem",
    "useBundledCa": false,
    "certStore": "bundled,system"
  }
}
```

`useBundledCa` по умолчанию считается `true`, если key отсутствует.
`tlsCaPath` optional и имеет приоритет над встроенным CA. Если managed policy
доставляет собственный дополнительный CA, он важнее пользовательского
`tlsCaPath`.

`certStore` выбирает базовые источники сертификатов: `bundled` (набор CA
Mozilla, поставляемый с runtime) и/или `system` (OS certificate store),
comma-separated списком. Unset означает оба — поэтому корпоративный root,
установленный в системное хранилище, доверен без какой-либо настройки.

Для proxies, требующих клиентский сертификат (mutual TLS), есть ещё три key:

| Key | Purpose |
| --- | --- |
| `clientCertPath` | Путь к client certificate PEM; требует `clientKeyPath` |
| `clientKeyPath` | Путь к client private key PEM; требует `clientCertPath` |
| `clientKeyPassphrase` | Опциональный passphrase для зашифрованного ключа — secret, никогда не логируется |

Эти значения читаются только из user-level config file — никогда из project,
workspace или plugin — поэтому checked-out repository не может перенаправить
TLS- или proxy-путь приложения.

Клиентский сертификат может прийти ещё из двух мест, под именами
`CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY` и
`CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`. Если их задаёт `env`-блок managed settings,
этот сертификат важнее заданного здесь. Если не задан ни тот, ни другой,
приложение берёт эти переменные из собственного environment (на macOS — включая
exports вашего login shell), и в desktop app, и на headless server. Настройки CA
действуют при любом предъявленном сертификате.

Изменения применяются сразу — restart не нужен. Те же proxy- и TLS-настройки
доверия достигают auto-updater и agent subprocesses, так что обновления и
трафик агента тоже идут корпоративным сетевым путём.

## Как это работает

Когда proxy включен, traffic маршрутизируется на трех уровнях:

1. **Node.js main process** — `fetch()` calls (OAuth flows, MCP connections,
   API requests) идут через [undici](https://github.com/nodejs/undici)
   `ProxyAgent`, установленный как global dispatcher, с HTTPS CONNECT
   tunnelling для secure connections и учетом No-proxy rules.
2. **Electron sessions** — requests из browser pane, update feed и OAuth
   browser windows используют Chromium proxy handling через
   `session.setProxy()`. Они идут через тот же proxy, который выбирает main
   process (см. ниже), и подключаются напрямую, если не выбран никакой.
3. **Agent subprocesses** — Claude, Pi и Codex backends получают `HTTP_PROXY`,
   `HTTPS_PROXY` и `NO_PROXY` (плюс lowercase forms) в environment, причём в
   `NO_PROXY` добавлены `localhost`, `127.0.0.1`, `::1` и `[::1]`, чтобы их обращения к
   локальным services самого приложения шли напрямую. Бинарник Codex не читает
   `NODE_EXTRA_CA_CERTS`, поэтому дополнительный CA file он получает как
   `CODEX_CA_CERTIFICATE`, если `CODEX_CA_CERTIFICATE` или `SSL_CERT_FILE` ещё не
   заданы; client certificate, заданный здесь, ему не передаётся.

TLS CA settings применяются к Node.js `fetch()` независимо от того, включен
proxy routing или нет.

**Proxy из managed settings и из environment.** Main process и Electron sessions
выбирают proxy в одном порядке. Первым идёт proxy, заданный `env`-блоком
managed settings, затем in-app настройка выше, затем environment: первая
заданная из `https_proxy`, `HTTPS_PROXY`, `http_proxy` и `HTTP_PROXY`, вместе с
`NO_PROXY` (или `no_proxy`). На macOS environment включает exports вашего login
shell. Если ничего из этого нет, requests идут напрямую. Это относится и к model
requests sessions Codex и Claude Code на gateway и custom-endpoint cards: там их
делает сам локальный adapter приложения, от имени session.
`NODE_EXTRA_CA_CERTS` из `env`-блока managed settings, а на macOS — из login
shell, тоже становится доверенным. Headless server выбирает proxy для своих
requests в том же порядке.

## Proxy authentication

Для proxies, которым нужны credentials, вставьте их в URL:

```
http://username:password@proxy.corp.com:8080
```

::: warning
Эти credentials лежат незашифрованными внутри `config.json`. Если policy требует
encrypted storage, настраивайте proxy на уровне OS, а не в app.
:::

## No-proxy rules

Поле **No proxy** — это comma- или whitespace-separated list bypass patterns:

| Pattern            | Matches                                |
| ------------------ | -------------------------------------- |
| `*`                | All hosts (effectively disables proxy) |
| `example.com`      | Exact hostname                         |
| `.example.com`     | All subdomains of example.com          |
| `example.com:8080` | Specific host and port                 |
| `192.168.1.1`      | Exact IP address                       |
| `[::1]`            | IPv6 address                           |
| `[::1]:8080`       | IPv6 address with port                 |

::: info
Loopback-адреса — `localhost`, `127.0.0.1` и `::1` — всегда идут мимо proxy,
что бы ни было в No proxy: proxy, получивший `127.0.0.1`, попал бы на свою
машину, а не на вашу. Другие local services, например host в вашей LAN, по-прежнему
нужно перечислить в No proxy.
:::

## TLS-intercepting proxies (corporate firewalls)

Многие corporate proxies делают TLS inspection: заново подписывают HTTPS traffic
внутренним Certificate Authority (CA). Симптом отсутствующего trust anchor —
`fetch failed`. Поскольку default `certStore` включает OS store, корпоративный
root, установленный IT системно, обычно уже доверен; настройки ниже — для CA,
которых нет в системном хранилище.

### Symptoms

- Sign-in через OAuth выбрасывает **"fetch failed"**, или browser window вообще
  не появляется.
- MCP connections падают в corporate network, но работают в другой сети.
- Browser-pane requests работают (Chromium использует system certificate store),
  а agent-initiated requests падают.

### Solution

Nessy Desktop поставляется со встроенным CA T-Bank и по умолчанию использует
его для Node-запросов. Это покрывает API key connection tests, OAuth token
exchange, refresh списка моделей и другие запросы через Node `fetch()`, даже
когда proxy routing выключен.

Если в вашей организации используется другой corporate CA, укажите абсолютный
PEM-путь в **Settings → App → Network → Пользовательский CA-сертификат**.
Пользовательский CA имеет приоритет над встроенным CA. Также можно выключить
**Использовать встроенный CA T-Bank**, если вашей среде не нужно ему доверять.

Как process-start fallback, можно запустить app с `NODE_EXTRA_CA_CERTS`,
заданным до старта Nessy Desktop:

**macOS — one-time launch from a terminal:**

```bash
NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem open -a "Nessy Desktop"
```

**macOS — permanent (Dock/Spotlight launches too):**

Приложение читает environment вашего login shell при запуске, поэтому
`export NODE_EXTRA_CA_CERTS=…` в `~/.zprofile` или `~/.zshrc` доходит до него,
как бы его ни запустили, и начиная с 1.41.0 действует не только на agents, но и
на собственные requests приложения. Чтобы задать переменную для всех apps,
запускаемых из Dock или Spotlight, используйте `launchctl`:

```bash
launchctl setenv NODE_EXTRA_CA_CERTS /path/to/corporate-ca.pem
```

Затем relaunch. Проверить и удалить:

```bash
launchctl getenv NODE_EXTRA_CA_CERTS
launchctl unsetenv NODE_EXTRA_CA_CERTS
```

Начиная с macOS 10.10, значение, заданное через `launchctl setenv`, переживает
reboots для GUI sessions. В managed fleets IT может развернуть ту же переменную
через MDM LaunchAgent plist.

**Windows — one-time launch from PowerShell:**

```powershell
$env:NODE_EXTRA_CA_CERTS = "C:\path\to\corporate-ca.pem"
& "$env:LOCALAPPDATA\Programs\nessy-desktop\Nessy Desktop.exe"
```

**Windows — permanent:** задайте User (или Machine) environment variable с именем
`NODE_EXTRA_CA_CERTS` через System Properties или:

```powershell
[System.Environment]::SetEnvironmentVariable(
  "NODE_EXTRA_CA_CERTS",
  "C:\path\to\corporate-ca.pem",
  "User"
)
```

Выйдите из системы и войдите снова или перезагрузитесь, чтобы Explorer-launched
apps увидели переменную.

**Linux — one-time launch:**

```bash
NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.pem nessy-desktop
```

**Linux — permanent:** добавьте переменную в `~/.profile` и
`~/.config/environment.d/proxy-ca.conf` (читает systemd user sessions), затем
выйдите и войдите снова.

### Получение CA certificate

Запросите corporate proxy CA у IT. Чтобы извлечь его самостоятельно:

```bash
openssl s_client -connect api.anthropic.com:443 -proxy proxy.corp.com:8080 -showcerts </dev/null 2>/dev/null | openssl x509 -outform PEM > corporate-ca.pem
```

Certificate должен быть PEM (начинается с `-----BEGIN CERTIFICATE-----`).
Преобразуйте `.cer`/`.der`, если нужно:

```bash
openssl x509 -inform DER -in corporate-ca.cer -out corporate-ca.pem
```

Не используйте `NODE_TLS_REJECT_UNAUTHORIZED=0` как workaround. Это отключает
TLS verification. Если вы кратко использовали его для локальной диагностики,
уберите переменную перед обычной работой.

## Troubleshooting

**"Fetch failed" on OAuth sign-in.** Почти всегда это TLS-intercepting proxy —
см. раздел выше.

**Browsing works but OAuth does not.** Chromium (browser pane) читает system
certificate store, а OAuth discovery и token exchange идут через Node `fetch()`.
Оставьте включенным встроенный CA T-Bank или укажите **Пользовательский
CA-сертификат** для CA, которым подписывается corporate traffic.

**MCP servers won't connect.** Проверьте, что host server не добавлен в No proxy,
если только вы не хотели обходить proxy. Local (stdio) MCP servers — обычные
subprocesses, поэтому proxy settings их не касаются.

**Proxy authentication fails.** Проверьте credentials через `curl` и URL-encode
special characters в password (например `p%40ss` для `p@ss`). NTLM proxies
напрямую не поддерживаются; local NTLM-to-Basic bridge может помочь.

**Confirm the proxy is active.** Проверьте macOS main log на applied settings:

```
~/Library/Logs/Nessy Desktop/main.log
```
