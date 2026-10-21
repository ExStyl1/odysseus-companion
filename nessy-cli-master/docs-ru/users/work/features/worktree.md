---
title: Worktree
---

# Worktree

Git worktree изолирует экспериментальные изменения во временной рабочей копии, не прерывая текущую сессию.

## Быстрый старт

```bash
nessy --worktree
nessy --worktree my-feature
nessy --worktree=my-feature
nessy --worktree=#4174
nessy --worktree https://github.com/NessyLM/nessy-cli/pull/4174
nessy --resume <session-id> --worktree=my-feature
```

:::tip
Поскольку значение флага необязательно, `nessy --worktree "say hi"` считает prompt именем worktree. Используйте `--worktree=my-feature`, ставьте bare-флаг после prompt либо отделяйте следующим флагом.
:::

При `--resume --worktree foo` picker показывает только сессии, сохранённые внутри `foo`; для известной сессии укажите её ID. До первого шага CLI переключает `cwd` в worktree. Флаг несовместим с `--acp`/`--experimental-acp`: ACP-host должен передать путь как `cwd` в `loadSession`/`newSession`.

Worktree можно запросить и во время сессии («создай worktree experiment-a»), а затем попросить выйти с удалением или сохранением.

## Создаваемые объекты

```text
<repoRoot>/.nessy/worktrees/<slug>/
                          ↳ branch worktree-<slug>
```

Slug содержит буквы, цифры, `.`, `_`, `-` и не более 64 символов; автоматически создаётся `<adjective>-<noun>-<6hex>`, для PR — `pr-<N>`. Обычная ветка основана на текущей ветке, PR-ветка — на загруженном `FETCH_HEAD`. `core.hooksPath` указывает на `.husky/` либо `.git/hooks/`. Каталоги из `worktree.symlinkDirectories` подключаются символическими ссылками. Основной путь worktree не настраивается; `agents.arena.worktreeBaseDir` относится только к Arena.

## Интерфейс, выход и восстановление

Footer показывает `⎇ worktree-experiment-a (experiment-a)`. В JSON custom status line появляется объект `worktree` с `name`, `path`, `branch`, `original_cwd`, `original_branch`; встроенную строку можно скрыть через `ui.hideBuiltinWorktreeIndicator`.

Двойной `Ctrl+C`/`Ctrl+D` открывает диалог Keep/Remove/Cancel и показывает число новых коммитов и изменённых файлов. При ошибке проверки состояния выбирайте Keep или Cancel. Привязка сохраняется в `<chatsDir>/<sessionId>.worktree.json`. При resume живой worktree восстанавливается и модель получает напоминание; отсутствующий каталог приводит к тихому удалению sidecar. Это одинаково работает в TUI, headless и ACP, однако `process.cwd()` при восстановлении автоматически не меняется.

## Изоляция субагентов

`agent` принимает `isolation: "worktree"` вместе с `subagent_type`. Создаётся `<repoRoot>/.nessy/worktrees/agent-<7hex>/`: чистая копия удаляется после завершения, копия с изменениями сохраняется и возвращается в результате. Background-агенты поддерживаются.

Осиротевшие `agent-<7hex>` старше 30 дней удаляются при старте только если нет незакоммиченных изменений, локальных недоступных на remote коммитов и ошибок чтения git. Именованные пользовательские worktree автоматически не удаляются.

## Защита при удалении

`exit_worktree action="remove"` проверяет владельца-сессию, запрещает удалять dirty tree без `discard_changes: true` и всегда запрещает удалять недоступные из других веток/remote коммиты. Эти проверки действуют и в диалоге; удаление всегда требует подтверждения.

## Настройки и инструменты

```jsonc
{
  "ui": { "hideBuiltinWorktreeIndicator": false },
  "worktree": { "symlinkDirectories": ["node_modules", ".turbo", "dist"] },
}
```

Абсолютные пути и `..` в `symlinkDirectories` запрещены; отсутствующие источники и существующие назначения пропускаются.

```json
{ "name": "experiment-a" }
```

`enter_worktree` требует git-репозиторий и запрещает вложенный worktree.

```json
{ "name": "experiment-a", "action": "remove", "discard_changes": false }
```

`exit_worktree` принимает обязательные `name`, `action: "keep" | "remove"` и при необходимости `discard_changes`. Подробнее об agent см. [Субагенты](./sub-agents.md).

## Ограничения

- Нет sparse checkout и интеграции tmux.
- Worktree считаются отдельными проектами для хранения сессий; для resume снова укажите тот же `--worktree`.
- Нельзя перенести сессию между slug из-за `projectHash(cwd)`.
- Mid-session `enter_worktree` не меняет `process.cwd()`/`Config.targetDir`; это делает только стартовый флаг.
- Флаги путей нормализуются до смены cwd только для `--mcp-config`, `--openai-logging-dir`, `--json-file`, `--input-file`, `--telemetry-outfile`, `--include-directories`; для остальных безопаснее абсолютные пути.
- PR требует GitHub remote `origin`; ошибки отсутствующего PR, неверного номера и 30-секундного timeout не создают worktree.

## Устранение неполадок

Для отсутствующего индикатора проверьте `ui.hideBuiltinWorktreeIndicator`. При проблеме resume проверьте sidecar и `--debug`/`restoreWorktreeContext`. Ошибка «created by a different session» требует исходной сессии либо ручного `git worktree remove`. Старые agent-worktree можно удалить вручную после `git worktree list` либо дождаться безопасной очистки.
