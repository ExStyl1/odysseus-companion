# Performance and Token Optimization

Verbose command output — один из самых быстрых способов сжечь context: большой `git diff`, recursive listing или long test log заполняют conversation текстом, который model всё ещё должна читать. Nessy Desktop может route Bash output через [RTK](https://github.com/rtk-ai/rtk) — local CLI, который shrinks noisy output everyday dev commands before model sees it.

RTK не меняет execution speed. Он trims token bill: same result reaches model in fraction of text, freeing context for code and reasoning.

::: tip
Permission prompt always shows **original** command, and exact command executes. RTK touches nothing but output routed back to model.
:::

## What It Helps With

Token optimization pays off most in coding and repository work, where sessions run commands that print many repetitive text:

```bash
git diff
rg "TODO|FIXME" .
bun test
ls -R
```

Leave feature off, and every byte raw output lands in conversation verbatim. Turn it on, and Nessy Desktop hands eligible Bash commands to RTK, which compacts output before model reads it. Benefits:

- Lower token usage on common development commands.
- More context left for actual work.
- Less noise from long diffs, listings and logs.
- Saved-token statistics visible in Settings.

Commands already printing short targeted output see little benefit.

## Requirements

- Binary `rtk` installed on PATH.
- RTK версии `0.44.0` или новее. Версии от `0.23.0` до `0.43.x` незаметно меняют вывод, который читает агент, — строка `grep` с двоеточием обрезается, ввод, перенаправленный в `wc`, игнорируется, вывод через pipe может упасть, — поэтому Nessy Desktop никогда не пропускает команды через них (см. [Устаревший RTK](#устаревшии-rtk)). Версии до `0.23.0` вообще не умеют `rtk rewrite` и считаются неустановленными.
- Сессия Pi или Claude Code. Сессии Codex выполняют команды без изменений: в рантайм Codex RTK не подключён.

Nessy Desktop does **not** bundle RTK. It looks for executable `rtk` already on PATH and runs it locally, passing flag suppressing RTK telemetry on every call. There is no `rtk init` step — that command wires RTK into other tools' hooks, while Nessy Desktop simply calls `rtk rewrite` itself.

## Enabling It

1. Install RTK for platform (Homebrew, install script or Cargo — see RTK project).
2. Under **Settings → AI → Performance**, hit **Re-check**. Changed PATH recently? Quit and relaunch Nessy Desktop first, otherwise desktop process keeps stale environment.
3. Turn on **Token Optimization**.
4. Work through session that runs plenty of commands.
5. Back in same **Performance** panel, check saved-token summary once RTK processed a few.

Panel stuck on **Get RTK** means one of three things: no binary, version older than `0.23.0`, or binary unreachable from desktop app PATH. Detection cached per process, so relaunch app when installing/upgrading RTK.

## Устаревший RTK

Если `rtk` в вашем PATH имеет версию от `0.23.0` до `0.43.x`, панель **Performance** пишет **rtk *версия* is outdated** — «Paused: versions before 0.44.0 corrupt some command output», — и Token Optimization остаётся на паузе: команды выполняются без изменений, пока не найдётся безопасная версия. Кнопка **Update…** открывает окно, где названы минимальная версия и место, где установлена устаревшая копия. Пока Token Optimization включён, это же окно открывается само — один раз для каждой устаревшей версии; **Later** скрывает его для этой версии.

Nessy Desktop не предлагает команду установки. Обновите RTK тем же способом, каким устанавливали (Homebrew, установочный скрипт или Cargo), и нажмите **Re-check** в окне. Если находится всё та же старая версия, значит, в PATH раньше стоит другая копия или терминал, из которого запущено приложение, держит старый PATH — перезапустите его.

## How Rewriting Works

For each Bash command, Nessy Desktop asks `rtk rewrite` whether compressed equivalent exists:

- If RTK returns rewrite, SDK runs compressed form and model sees compact output.
- If no equivalent, command runs unchanged.
- On any error — timeout, spawn failure or identical output — Nessy Desktop falls through to original command.

Model conversation history still shows command actually run (`git status`), not rewritten form.

Пока RTK активен, инструкции агента говорят, что вывод частых команд сжимается, и объясняют, как получить точный вывод, когда он нужен.

### Команды, которые RTK не трогает

Некоторые команды никогда не передаются RTK:

- Команда, которая начинается с `command` или `builtin`, — обычный способ попросить настоящую программу; именно этот выход агенту и подсказывают для точного вывода.
- Программа, названная по пути (`/usr/bin/grep`) или с обратной косой чертой в начале (`\grep`): такие RTK не трогает сам.
- Любая базовая команда из списка `rtkExcludeCommands` в [`config.json`](../reference/config/config-file). Используйте его для инструмента, вывод которого всегда нужен дословно:

```json
{
  "rtkEnabled": true,
  "rtkExcludeCommands": ["grep", "jq"]
}
```

Список сравнивается с первым словом команды и читается при каждом вызове, так что правка действует со следующей команды без перезапуска.

## Troubleshooting

- **Panel insists RTK is missing.** Press **Re-check** first. Still no luck? Run `rtk` from same OS shell app inherits (`which rtk && rtk --version` on macOS/Linux, `Get-Command rtk; rtk --version` on Windows). Windows users: binary must be on Windows PATH itself, not only Git Bash/MSYS PATH.
- **`rtk --version` works but toggle won't enable.** Проверьте версию — нужна `0.44.0` или новее; более старая показывается как устаревшая (см. [Устаревший RTK](#устаревшии-rtk)).
- **Вывод одного инструмента выглядит неправильно.** Добавьте имя его команды в `rtkExcludeCommands` или попросите агента начать команду с `command`.
- **`rtk gain` looks wrong.** Make sure you installed `rtk-ai/rtk`, not unrelated tool sharing binary name.

## Other Latency Factors

RTK addresses token cost, not wall-clock speed. Most perceived latency comes from model response time, source calls and document conversion. Habits:

- Keep prompts focused and enable only needed sources.
- Summarise or start fresh before long implementation phase rather than dragging huge history.
- Prefer narrow [local folder](../sources/local-filesystems) source over broad directory tree.
- Pick model fitting task — see [model choice below](#model-choice).

## Model Choice

Built-in [Nessy Gateway](../getting-started/introduction) offers default coder model and faster lighter model. Use fast model when latency matters more than maximum reasoning depth, and coder model for deep implementation work.
