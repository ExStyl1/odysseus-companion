# macos-internal-seatbelt-profile

## AIDT

AIDT-7028

## Зачем

Nessy CLI нужны model-aware macOS Seatbelt-профили: внутренний профиль для
`dp-auth` моделей с `model.internal=true` и отдельный более жесткий профиль для
внешних моделей, включая внешние модели, пришедшие через `dp-auth`.

Оба профиля жестче upstream `permissive-*`: `deny default`, запись только в
рабочие каталоги, runtime, temp и кэши, запрет пользовательских секретов и
чувствительных UNIX-сокетов. Оба model-профиля разрешают сеть и `localhost`, но
запрещают служебные loopback-порты `1..1023`, Docker TCP `2375/2376` и
чувствительные UNIX-сокеты, как в `t-agents`. `internal-model-open`
дополнительно разрешает `mach-register`, широкий `mach-lookup` с denylist
чувствительных сервисов, `iokit-open` и кэш Playwright, чтобы могли работать
JetBrains MCP, Chrome DevTools MCP, Playwright MCP и похожие доверенные
локальные интеграции. `external-model-open` оставляет browser-automation права
закрытыми, но сохраняет `~/.dp` открытым для корпоративных MCP.

Выбор делается в CLI перед relaunch в `sandbox-exec`: если `SEATBELT_PROFILE`
не задан явно, Nessy CLI выбирает профиль после `refreshAuth()`. Если текущий
auth type не `dp-auth` или еще не выбран, используется `external-model-open`.
Для `dp-auth` дополнительно смотрим `model.internal`: только
`model.internal=true` выбирает `internal-model-open`, остальные `dp-auth` модели
остаются в `external-model-open`. Явно заданный `SEATBELT_PROFILE` остается
приоритетнее автоматического выбора. После запуска в одном из model-профилей
смена модели через границу требуемого профиля запрещена: нужно перезапустить CLI
с целевой стартовой политикой.

## Файлы

- `packages/cli/src/utils/sandbox.ts`
- `packages/cli/src/utils/sandbox-macos-external-model-open.sb`
- `packages/cli/src/utils/sandbox-macos-internal-model-open.sb`
- `packages/cli/src/gemini.tsx`
- `packages/cli/src/gemini.test.tsx`
- `packages/core/src/config/config.ts`
- `packages/core/src/config/config-seatbelt-profile-guard.test.ts`
- `docs/users/features/sandbox.md`
- `scripts/create-standalone-package.js`
- `scripts/tests/standalone-internal-seatbelt-profile.test.js`

## Функциональные последствия

1. `external-model-open` является безопасным дефолтом, если auth type не выбран
   или auth type не `dp-auth`. Это не дает случайно попасть в более слабый
   browser-automation профиль до того, как известна внутренняя модель.
2. Для `dp-auth` профиль выбирается после `refreshAuth()`, потому что именно там
   подтягивается актуальная модельная metadata. `internal-model-open` включается
   только для `dp-auth` моделей с `model.internal=true`; внешние `dp-auth` модели
   остаются в `external-model-open`.
3. Оба model-профиля разрешают `localhost`, чтобы работали локальные HTTP/SSE
   MCP, `nessy serve`, локальный OTEL и Chrome DevTools/CDP на старших портах.
   При этом запрещены `localhost:1..1023`, Docker TCP `2375/2376` и
   чувствительные UNIX-сокеты.
4. `internal-model-open` дополнительно разрешает browser-automation права:
   `mach-register`, широкий `mach-lookup` с denylist чувствительных сервисов,
   `iokit-open` и запись в `~/Library/Caches/ms-playwright`. Это нужно для
   Playwright/Chrome DevTools сценариев, но граница по macOS Mach/XPC слабее,
   чем в `external-model-open`.
5. В работающем приложении нельзя переключаться через границу требуемого
   model-профиля внутри `internal-model-open`/`external-model-open`: профиль
   выбирается только на старте процесса.
6. Профили разрешают запись в `TMP_DIR`, который передает `nessy-cli`
   (`os.tmpdir()` / `$TMPDIR` на macOS), но не разрешает произвольный `/tmp`.
   Инструменты с хардкодом `/tmp` могут получить `Operation not permitted`.
7. Блокировка секретных путей идет после allow на workspace/runtime/cache, чтобы
   секреты не открывались случайным `TARGET_DIR`/`NESSY_HOME`. Если
   `NESSY_HOME` или `NESSY_RUNTIME_DIR` указаны внутрь запрещенного пути
   (`~/.config`, `~/.ssh`, `~/.aws` и т.п.), запись в runtime может сломаться.
   Это нужно закрывать отдельной startup-валидацией путей, а не переносом
   широких allow-правил в конец профиля.
8. Полный запрет `~/.config` также блокирует XDG-конфиги вроде `gh` и git config
   в XDG-пути. Сейчас это принято как более безопасный дефолт для внутреннего
   профиля.
9. `trustedFolders.json` внутри `NESSY_DIR` доступен на чтение, но закрыт на
   запись. Агент в песочнице не должен сам расширять список доверенных
   директорий. `settings.json` этим патчем не закрывается: это отдельное
   продуктовое решение, потому что оно сильнее влияет на пользовательские
   сценарии настройки.
10. В обоих профилях закрыты история команд shell и профили браузеров на базе
    Chromium (`Brave`, `Microsoft Edge`, `Arc`) и Firefox, потому что они могут
    содержать команды, токены, cookie и историю с чувствительными URL. Для
    Chrome DevTools MCP ожидаемый путь: подключение к уже запущенному браузеру по
    `localhost`, а не чтение профиля браузера из sandbox.
11. Для системной проверки TLS в `external-model-open` разрешен `mach-lookup` к
    `com.apple.TrustEvaluationAgent`. Без этого `/usr/bin/curl`, системный
    `python3`, `git` и другие инструменты, которые используют системное хранилище
    доверия macOS, могут ломаться за корпоративным MITM-прокси. Общее
    разрешение на `mach-lookup` при этом не открывается. В `internal-model-open`
    используется широкий `mach-lookup`, потому что профиль уже предназначен для
    доверенных внутренних browser/MCP сценариев.
12. Login-shell внутри песочницы может писать в stderr `Operation not permitted`
    при чтении `~/.profile`, `~/.zshrc` и похожих файлов. Это ожидаемая цена
    запрета shell-конфигов: `PATH` и другие настройки из этих файлов не
    применятся автоматически.
13. Как в `t-agents`, профили точечно открывают корпоративные исключения для
    внутренних MCP. Read на `~/.ssh/combined-ca.pem` и read/write на `~/.dp`
    есть в обоих model-профилях.
14. Package-manager cache allowlist приближен к `t-agents`: добавлены точечные
    macOS cache/state пути для pip/uv/poetry, Yarn/pnpm/deno, go-build и conda.
    Весь `~/Library/Caches` не открывается. Из-за этого `~/.local/bin` остается
    доступным для записи как часть состояния Python/tooling; это полезно для
    разработческих сценариев, но одновременно является известным компромиссом по
    риску закрепления в окружении.
15. Проверочный smoke под `internal-model-open` запускал Playwright Chromium,
    открывал страницу, поднимал Chrome DevTools/CDP endpoint на старшем
    localhost-порту и подключался через `connectOverCDP`.
16. Выбор профиля после `refreshAuth()` требует, чтобы процесс, который
    запускает `sandbox-exec`, сам умел ходить в dp-auth по TLS. Node читает
    `NODE_EXTRA_CA_CERTS` до старта JS, поэтому `packages/cli/src/bootstrap.ts`
    дополнительно добавляет bundled CA в trust store текущего процесса, а не
    только в env для дочерних.

## Откат

1. Убрать `[nessy-fork] macos-internal-seatbelt-profile` маркеры.
2. Удалить `external-model-open` и `internal-model-open` из
   `BUILTIN_SEATBELT_PROFILES`.
3. Удалить `packages/cli/src/utils/sandbox-macos-external-model-open.sb` и
   `packages/cli/src/utils/sandbox-macos-internal-model-open.sb`.
4. Удалить стартовый выбор `SEATBELT_PROFILE` из `packages/cli/src/gemini.tsx` и
   runtime-запрет смены model-профиля из `packages/core/src/config/config.ts`.
5. Удалить описание `external-model-open` и `internal-model-open` из
   `docs/users/features/sandbox.md`.
6. Удалить allowlist для `sandbox-macos-external-model-open.sb` и
   `sandbox-macos-internal-model-open.sb` из standalone packaging.
7. Удалить тесты на built-in Seatbelt assets, model-aware выбор профиля,
   runtime-запрет смены model-профиля и разрешенные model-profile `.sb` dist
   assets.
8. Удалить строку из `docs/fork-patches/README.md` и этот файл.

## Тесты

В macOS-тестах для Seatbelt и packaging-фикстур временные каталоги нужно
нормализовать через `realpathSync(mkdtempSync(...))`. Иначе путь из `/var` может
не совпасть с путем из `/private/var`, который видит ядро или ESM-загрузчик
Node.js, и тест станет ложнозеленым.

## Upstream

Не отправлен. При подливке upstream сохранить профиль как отдельную локальную
добавку и не переносить изменения в upstream `permissive-*`/`restrictive-*`
профили без отдельного решения.
