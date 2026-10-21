---
name: "revdiff"
description: "Интерактивное ревью в revdiff TUI с чтением пользовательских аннотаций и исправлением замечаний."
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.

Ссылки на прежние имена в исходных руководствах разрешай до загрузки навыка: «refactor» → «safe-refactor», режим «refactor». Старое имя не является отдельной командой.
<!-- /odysseus-invocation-policy -->

## Odysseus: user-approved supplied skill

This skill was explicitly added by the user as an exception to the base
local/browser/Obsidian catalog. The services, local applications and MCP/CLI
integrations required by this skill are permitted for its requested workflow.
The local-only restriction of unrelated skills does not disable this exception.

Importing the skill does not connect a service, install a runtime or authorize
sending messages, publishing artifacts or changing external records by itself.
Use the host's available tools and the user's actual task authorization.
Resolve bundled scripts, assets and references from this installed skill's own
root; write task outputs in the user's working project. If a required tool,
connection or referenced resource is absent, report the exact dependency rather
than inventing a successful result.

---


# revdiff Skill for Nessy CLI

Review diffs, files, and documents with inline annotations using revdiff TUI.
User runs revdiff manually in their terminal, adds annotations, then signals completion.
Skill reads annotations from history, classifies them, and implements code changes.

## Simple Workflow

**1. You review:**
```bash
revdiff --untracked     # or: revdiff HEAD~1, revdiff README.md
```

**2. Add annotations in TUI**, quit with `q`

**3. Signal completion:**
- "готово", "закончил", "finished", "done"

**4. I read and fix:**
- Read annotations from `~/.config/revdiff/history/`
- Classify: explanations vs code changes
- Implement fixes after approval

---

## Activation Triggers

- **Review**: "revdiff", "review diff", "annotate diff", "review changes"
- **With ref**: "revdiff HEAD~1", "revdiff main", "revdiff feature-branch"
- **File review**: "revdiff README.md", "review this file"
- **Completion**: "готово", "закончил", "finished", "done" — read annotations and fix
- **Config**: "revdiff config", "revdiff themes", "revdiff keybindings"

## Answering Questions

If the user asks a question **about** revdiff (configuration, themes, keybindings, installation, usage)
rather than requesting a review session, answer directly without launching the TUI. Consult documentation
or search for revdiff configuration files.

## Prerequisites

**Install revdiff:**
```bash
brew install umputun/apps/revdiff
```

**Verify:** `which revdiff` → `/opt/homebrew/bin/revdiff`

---

## Usage Modes

### Review Uncommitted Changes (default)
```bash
revdiff --untracked
```

### Review Last Commit
```bash
revdiff HEAD~1
```

### Review Branch vs Main
```bash
revdiff main HEAD
```

### Review Specific File
```bash
revdiff README.md
```

### Review All Files
```bash
revdiff --all-files
```

---

## After You Finish Reviewing

Say: **"готово"**, **"закончил"**, **"finished"**, or **"done"**

I will:
1. Read latest annotations from `~/.config/revdiff/history/`
2. Classify each annotation:
   - **Explanation requests** (contain `??` or start with "explain", "what is", "how does") → answer questions
   - **Code-change directives** → propose fix plan
3. Implement approved changes
4. Re-launch revdiff for follow-up if needed

---

## How I Process Annotations

### Annotation Format
```
## handler.go:43 (+)
use errors.Is() instead of direct comparison

## handler.go:43-67 (+)
refactor this hunk to reduce nesting

## handler.go (file-level)
consider splitting this file
```

### Classification

**Explanation Requests** — contain `??` or start with:
- `explain`, `remind`, `describe`
- `what is`, `what are`, `how does`, `how do`
- `clarify`, `why`

→ I answer these questions with code references

**Code-Change Directives** — everything else

→ I propose a fix plan and implement after approval

---

## Reading Annotations

When you say "готово", "закончил", "finished", or "done":

```bash
latest_review=$(ls -t ~/.config/revdiff/history/*/*.md 2>/dev/null | head -1)
if [ -n "$latest_review" ]; then
  cat "$latest_review"
fi
```

Then I:
1. Parse each annotation (file, line, type, comment)
2. Classify: explanation vs code-change
3. Answer explanations immediately
4. Propose fix plan for code changes
5. Implement after your approval
6. Loop: re-launch revdiff or confirm complete

## Example

```
You: revdiff --untracked
     [annotate in TUI, press q]
You: готово

I: [reads annotations]
   Found 3 annotations:
   
   1. handler.go:43 — use errors.Is()
   2. store.go:18 — restore validation
   3. handler.go — explain mutex purpose [explanation]
   
   Answering #3: [explains mutex]
   
   Plan for #1, #2:
   1. handler.go:43 — add errors.Is() check
   2. store.go:18 — restore validation
   
   Proceed?

You: yes

I: [implements changes]
    [commits or stages]
    
    All annotations addressed. 
    Run revdiff again for follow-up?
```

---

## Key Principles

- **Manual TUI launch** — revdiff needs interactive TTY
- **Signal completion** — "готово", "finished", "done"
- **Auto-read annotations** — from `~/.config/revdiff/history/`
- **Classify first** — explanations vs code changes
- **Plan before implementing** — show fix plan, wait for approval
- **Loop until complete** — re-launch for follow-up annotations

---

## Config & Troubleshooting

**Themes:** `revdiff --help` shows `--chroma-style` options (default: catppuccin-macchiato)

**Keybindings:** `?` in TUI shows help

**No annotations found?**
```bash
ls -la ~/.config/revdiff/history/
```

**Manual read:**
```bash
cat ~/.config/revdiff/history/*/annotations-*.md | tail -50
```
