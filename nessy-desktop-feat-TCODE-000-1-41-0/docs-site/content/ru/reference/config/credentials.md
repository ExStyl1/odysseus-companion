# Credentials

Nessy Desktop хранит API keys, OAuth tokens и другие secrets в зашифрованном
файле, отдельно от несекретного [config file](config-file). Эта страница
объясняет, где находится файл, как он защищен, как именуются credentials и как
их проверить или удалить.

## Расположение

`CONFIG_DIR` равен `NESSY_CONFIG_DIR`, если переменная задана, иначе —
`~/.nessy-agent`:

```
CONFIG_DIR/credentials.enc
```

Токен удалённой Workspace хранится в этом vault под ключом
`remote_server_token::{workspaceId}`. Конфигурация Workspace содержит только URL
и remote Workspace ID; токен не попадает в Workspace DTO и не подставляется при
повторном подключении.

## Граница authentication при чистом переходе

Storage v2 никогда не импортирует старый `credentials.enc` из карантина v1.
Учётные данные остальных providers и Sources нужно ввести или авторизовать
заново.

Nessy Gateway — исключение, потому что его общий файл находится вне
`CONFIG_DIR`:

```
~/.nessy/dp_auth_creds.json
```

Storage readiness и cutover считают этот контракт nessy-cli внешним и
read-only. В обычном Gateway auth flow единственным модулем Nessy Desktop с
правом записи остаётся `packages/shared/src/auth/dp`; валидный сохранённый JWT
используется повторно. При переходе файл не копируется в v2 и не изменяется.

## Шифрование

Credentials запечатываются authenticated encryption:

- **Algorithm**: AES-256-GCM.
- **Key derivation**: PBKDF2 (100,000 iterations) поверх стабильного machine
  identifier.
- **Machine identifier**: OS-native hardware UUID — `IOPlatformUUID` на macOS,
  `MachineGuid` на Windows, `/var/lib/dbus/machine-id` на Linux — с fallback на
  username/home-directory, если UUID недоступен.

Так как key привязан к машине, файл можно расшифровать только на компьютере,
который его создал. Копирование `credentials.enc` на другую машину не сработает;
там нужно пройти authentication заново.

::: info
OS keychain prompt не появляется. Backend с зашифрованным файлом дает защиту
уровня keychain без interactive unlock при каждом запуске. Credential backend
через environment variables отключен, поэтому credentials никогда не берутся из
shell environment variables — вы вводите их через app.
:::

## Credential keys

Каждый сохраненный secret адресуется key с delimiter `::`. Используется `::`, а
не `/`, чтобы delimiter не конфликтовал со slashes в URLs или paths.

**Global credentials (2 parts):**

```
{type}::global
```

**LLM connection credentials (2 parts):**

```
{type}::{connectionSlug}
```

**Workspace credentials (2 parts):**

```
workspace_oauth::{workspaceId}
```

**Source credentials (3 parts):**

```
{type}::{workspaceId}::{sourceId}
```

## Credential types

| Type                  | Description                                            | Scope          |
| --------------------- | ------------------------------------------------------ | -------------- |
| `anthropic_api_key`   | Anthropic API key (legacy global)                      | Global         |
| `claude_oauth`        | Claude OAuth token, Pro/Max subscription (legacy)      | Global         |
| `telemetry_salt`      | Per-install pseudonymization salt для opt-in telemetry | Global         |
| `llm_api_key`         | API key for an LLM connection                          | Per connection |
| `llm_oauth`           | OAuth token for an LLM connection                      | Per connection |
| `llm_iam`             | AWS IAM credentials                                    | Per connection |
| `llm_service_account` | GCP service-account JSON                               | Per connection |
| `workspace_oauth`     | Workspace MCP OAuth token                              | Per workspace  |
| `remote_server_token` | Remote Workspace server token                          | Per workspace  |
| `source_oauth`        | OAuth token for an MCP/API source                      | Per source     |
| `source_bearer`       | Bearer token for a source                              | Per source     |
| `source_apikey`       | API key for a source                                   | Per source     |
| `source_basic`        | Basic auth (base64 `user:pass`) for a source           | Per source     |

::: info
`anthropic_api_key` и `claude_oauth` остаются поддерживаемыми global key types.
Новые настройки хранят credentials для каждой LLM connection по её slug. Это не
означает импорт credential file v1.
:::

## Что хранится здесь, а что в config

В `credentials.enc` должны быть только secrets. Несекретная routing metadata —
model names, base URLs, source names, workspace и connection identifiers —
остается в `config.json` и per-workspace files, которые являются plain JSON. Не
вставляйте secrets в prompts, source definitions или documentation, если поле не
является явно credential field.

## Примеры

```
anthropic_api_key::global
claude_oauth::global
llm_api_key::nessy-gateway
llm_oauth::claude-max
remote_server_token::ws-abc123
source_oauth::ws-abc123::github
source_bearer::ws-abc123::internal-api
```

## Добавление credentials

Credentials сохраняются автоматически, когда вы:

- Проходите setup flow (API key или OAuth login).
- Подключаете source, которому нужна authentication.
- Аутентифицируетесь на MCP server.

## Удаление credentials

Чтобы очистить все, закройте app и удалите файл:

```bash
rm "${NESSY_CONFIG_DIR:-$HOME/.nessy-agent}/credentials.enc"
```

При следующем запуске нужно заново пройти authentication для каждой connection и
source.

## Rotation

Rotating secret выполняется из Settings. Перезапустите активные sessions, куда
старое значение уже могло попасть в running subprocess, чтобы они получили новое.

## Security considerations

**File permissions.** Credential file записывается только для вашего user. На
POSIX system можно проверить:

```bash
ls -la "${NESSY_CONFIG_DIR:-$HOME/.nessy-agent}/credentials.enc"
# expect -rw-------
```

**Backups.** Сохраняйте весь `CONFIG_DIR`, включая этот файл. Он остаётся
encrypted и не расшифруется на другой машине. Внешние Project, `~/.agents` и
`~/.nessy/dp_auth_creds.json` в этот backup не входят.

**Machine migration.** Переезд на новый компьютер означает повторный ввод
credentials — encrypted file со старой машины не расшифруется на новой.

**Shared OS accounts.** Пользователи с одним operating-system account делят один
credential file. Для изоляции используйте отдельные accounts.

## Troubleshooting

**"Credential not found".** Entry могла быть удалена или файл reset. Повторно
введите API key в Settings или перезапустите OAuth login, когда появится prompt.

**"Cannot decrypt credentials".** Обычно это значит, что файл пришел с другой
машины. Удалите его и пройдите authentication заново:

```bash
rm "${NESSY_CONFIG_DIR:-$HOME/.nessy-agent}/credentials.enc"
```

**File permission errors.** Верните доступ только владельцу:

```bash
chmod 600 "${NESSY_CONFIG_DIR:-$HOME/.nessy-agent}/credentials.enc"
```

### Устранение проблем со входом в шлюз

С 1.38.0 чат на карточке Nessy Gateway никогда не ждёт сессию командной строки `dp`: ход выполняется на токене шлюза, который хранит приложение, а закончившаяся сессия показывает одно уведомление («Ваша сессия Developer Platform закончилась») — отказывают только инструменты Developer Platform. Другое уведомление («Nessy не удалось обратиться к командной строке Developer Platform») означает, что сам бинарь `dp` не ответил: проверьте `dp version` и `dp auth print-token | wc -l` (должна быть ровно одна строка), затем нажмите «Войти» на карточке шлюза.

Если карточка Nessy Gateway зацикливается на 401 («token is malformed») или
«Войти» не срабатывает вовсе, приложение само чинит испорченный кэшированный
токен — поэтому цикл, который переживает одну повторную попытку, обычно упирается
в сам `dp`. Проверьте его напрямую:

```bash
dp version                      # должно быть >= 13.x
dp auth print-token | wc -l     # должна быть ровно одна строка
dp ai mcp jira                  # должен работать (выход по Ctrl-C), а не падать
```

Если что-то из этого не так: обновите `dp`, удалите `~/.nessy/dp_auth_creds.json`
(тот самый общий файл, описанный выше), затем нажмите «Войти» на карточке шлюза.
Если задана переменная
[`NESSY_HOME`](environment-variables#nessy-home), этот путь переезжает вместе с
ней — удаляйте файл в том каталоге, который она называет.

#### Коды ошибок входа

Когда вход в шлюз не удаётся, карточка показывает одно из сообщений ниже, а
приложение запоминает рядом с ним код. С 1.41.0 баннер, шаг онбординга и
**Settings → AI → Reconnect** называют ту же ошибку, хотя раньше сообщали лишь,
что войти не удалось (а Reconnect не сообщал ничего). Здесь по одной строке на каждый член
`DpAuthError` из `packages/shared/src/auth/dp/errors.ts`, где эти коды и
объявлены: если вам встретился код, которого в таблице нет, устарела таблица.

| Что показывает карточка | Код | Что это значит и что делать |
| ----------------------- | --- | --------------------------- |
| CLI Developer Platform не найдена | `DpNotFound` | `dp` не найден ни в одном из четырёх мест, где ищет Nessy Desktop, по порядку: путь из [`NESSY_DP`](environment-variables#nessy-dp), системный `dp` (ваш `PATH`, затем `/usr/local/bin/dp`), `CONFIG_DIR/dp/bin/dp` и копия nessy-cli `NESSY_HOME/dp_latest/dp`. Nessy Desktop никогда не скачивает его сам — установите его или запросите в корпоративном IT; весь порядок — включая то, что будет, если названный путь не запускается, — описан в [`NESSY_DP`](environment-variables#nessy-dp). |
| Требуется вход в Developer Platform | `NeedsLogin` | Сессии `dp` нет либо она перестала работать. Нажмите **«Войти»** на карточке или выполните `dp auth login` сами. Сам чат продолжает работать — отказывают только инструменты Developer Platform. **Одно исключение:** если ход отклонил сам шлюз, а для перевыпуска токена, который это починил бы, понадобился вход, то на том токене, что есть у приложения, ход не пройдёт. Сообщение при этом не теряется — оно остаётся на карточке, и после входа приложение отправляет его повторно само. |
| Не удалось войти в Developer Platform | `LoginFailed` | `dp auth login` запустился и не завершился: шаг в браузере не был доведён до конца или `dp` сообщил о собственной ошибке. Повторите и следите за вкладкой браузера, которую он открывает. |
| Не удалось выполнить команду Developer Platform | `ExecFailed` | Команда `dp` завершилась ошибкой, не подходящей ни под один более точный случай выше. Выполните `dp version` и `dp auth print-token` в терминале и посмотрите, что говорит сам `dp`. |
| Не удалось обменять токен Developer Platform | `ExchangeFailed` | `dp` выдал токен, но шлюз отказался обменять его на сессионный токен или ответил чем-то непригодным. Проверьте сеть и VPN, затем повторите. |
| Время ожидания входа в Developer Platform истекло | `Timeout` | Шаг `dp` не уложился в свой бюджет — 30 секунд на `dp auth print-token`, 5 минут на `dp auth login`. Повторите; если повторяется, скорее всего `dp` не может достучаться до собственного бэкенда. |
| Developer Platform открыла браузер для входа и не дождалась ответа. Этот браузер может быть не виден на этой машине… | `LoginBrowserTimeout` | `dp auth login` пять минут ждал браузер, которого никто не видел — headless-машина, SSH-сессия, удалённый рабочий стол. Карточка называет адрес, до которого вход должен достучаться на ЭТОЙ машине (`http://localhost:25565/auth`); завершите вход в браузере, который его откроет (по SSH — пробросьте порт), затем снова нажмите **Sign in**. Это не 30-секундный `Timeout` выше: там шаг `dp` не ответил, здесь браузер так и не вернулся. |
| Вход в Developer Platform отменён | `Cancelled` | Вход был отменён — кнопкой «Отмена» или тем, что его инициировало и исчезло. Нажмите **«Войти»** ещё раз. |
| Вход в Developer Platform доступен только в локальном desktop-приложении | `InteractiveLoginUnavailable` | Вход запросили там, где некому ответить на приглашение браузера: headless-запуск или второй вход, пока идёт первый. В приложении дождитесь окончания первого. В headless вместо входа задайте [`NESSY_DP_AUTH_TOKEN`](environment-variables#nessy-dp-auth-token). |
| Не удалось войти в Developer Platform. Задана NESSY_CLI_DP_AUTH_TOKEN, а NESSY_DP_AUTH_TOKEN — нет: Nessy читает только свою переменную. Задайте NESSY_DP_AUTH_TOKEN или войдите интерактивно. | `CliEnvTokenOnly` | Вход не удался сам по себе, и единственная переменная с делегированным токеном на машине — переменная nessy-cli. Они не взаимозаменяемы — см. [«Это не переменная nessy-cli»](environment-variables#nessy-dp-auth-token). Задайте ещё и [`NESSY_DP_AUTH_TOKEN`](environment-variables#nessy-dp-auth-token) либо войдите с карточки. Сам по себе этот код не появляется и заменяет собой только те три ошибки, которых ваша собственная переменная позволила бы избежать, полностью минуя `dp`, — `DpNotFound`, `NeedsLogin` и `LoginFailed`. Любая другая ошибка сохраняет свою строку выше: отказ в обмене токена, таймаут, отменённый вход или ошибка команды `dp` показываются как есть, потому что заданная переменная их бы не устранила. |

Прежде чем один из этих кодов дойдёт до вас, происходят две вещи:

- **Пока `dp auth login` ждёт браузер**, каждый экран входа показывает кнопку
  **«Скопировать ссылку для входа»** (macOS и Linux). Если вкладка браузера не
  открылась, откройте ссылку в браузере на этом компьютере — вход завершается на
  `localhost:25565` здесь.
- **Когда сам `dp` не отвечает** — `DpNotFound`, `ExecFailed` или `Timeout` на
  `dp auth print-token`, — вход сначала пробует сессию `dp`, уже сохранённую на
  этом компьютере: читает её (только чтение) и один раз обменивает на токен
  шлюза. Если это сработало, кода вы не увидите — вход сообщит, что использовал
  сохранённую сессию. `dp` всё равно стоит починить: когда эта сессия истечёт,
  для входа он понадобится снова.

#### Что Nessy Desktop делает с `dp_auth_creds.json`

**Он никогда его не удаляет.** Очистка файла — единственный шаг, который вы
делаете руками.

**Но он его перезаписывает** — атомарно и сохраняя ключи, которые ему не
принадлежат, — на двух путях:

- после успешного входа или перевыпуска токена и
- когда он принимает ещё действующий токен из `~/.nessy/oauth_creds.json`
  nessy-cli — без запуска `dp` и без какого-либо запроса на вход.

Второй путь и объясняет, почему файл может вернуться сам после того, как вы его
очистили: достаточно входа в nessy-cli, который вы не считали бы входом в Nessy
Desktop. И общий доступ работает в обе стороны — nessy-cli читает тот же файл,
поэтому его очистка может заставить этот инструмент войти заново при следующем
запуске.
