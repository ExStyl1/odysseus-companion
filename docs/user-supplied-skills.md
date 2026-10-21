# Навыки из предоставленной папки skills

Импорт от 2026-10-20. Источник: `/Users/mcloving/Downloads/skills/`.

**54 набора, 57 определений SKILL.md, 55 новых самостоятельных навыков.**
Две вложенные копии Jira/GitLab идентичны отдельным навыкам и сохранены внутри
`search-all` как справочные `GUIDE.md`, но не установлены второй раз. Вложенный Wixie доступен отдельно.

Пользователь явно разрешил добавить весь набор как исключение из прежнего
локального профиля, включая корпоративные сервисы. У этих навыков
`executionProfile: user-approved-exception`; после объединения смешанные
точки входа используют `scoped-variants` с отдельным профилем каждого режима.
У прежних 245 исходных руководств сохраняется
`local-browser-obsidian`; ранее исключённые 69 навыков не восстановлены.

**На момент импорта: 300 импортированных + 1 служебный навык.**
После объединения повторов: **273 самостоятельных навыка**, включая служебный.
Имена ниже описывают историю импорта. Их текущие соответствия и режимы:
[полный справочник](skills-catalog-ru.md) и `shared/skills-consolidation.json`.

## Имена и исходные пути

- `agent-browser` ← `agent-browser/SKILL.md`.
- `agterm` ← `agterm/SKILL.md`.
- `ai-doc-generator` ← `ai-doc-generator/SKILL.md`.
- `allure-testops` ← `allure-testops/SKILL.md`.
- `analytics-sql` ← `analytics-sql/SKILL.md`.
- `architecture-analyzer` ← `architecture-analyzer/SKILL.md`.
- `artifact-publish` ← `artifact-publish/SKILL.md`.
- `pgsme-coverage-matrix` ← `auto-skill-pgsme-coverage-matrix/SKILL.md`.
- `skills-market-install` ← `auto-skill-skills-market-install/SKILL.md`.
- `brainstorm` ← `brainstorm/SKILL.md`.
- `user-brainstorming` ← `brainstorming/SKILL.md`.
- `camunda-modeler-editor` ← `camunda-modeler-editor/SKILL.md`.
- `user-caveman` ← `caveman/SKILL.md`.
- `clarify` ← `clarify/SKILL.md`.
- `create-skill` ← `create-skill/SKILL.md`.
- `dialectic` ← `dialectic/SKILL.md`.
- `dp-sage` ← `dp-sage/SKILL.md`.
- `finedog-tma` ← `finedog-tma/SKILL.md`.
- `generate-tests` ← `generate-tests/SKILL.md`.
- `gitlab-cli` ← `gitlab/SKILL.md`.
- `humanizer-ru` ← `humanizer-ru-1/SKILL.md`.
- `init-qa` ← `init-qa/SKILL.md`.
- `jira` ← `jira-1/SKILL.md`.
- `jira-cli` ← `jira/SKILL.md`.
- `learn` ← `learn/SKILL.md`.
- `mermaid-diagrams` ← `mermaid-diagrams/SKILL.md`.
- `mermaid` ← `mermaid/SKILL.md`.
- `n8n-cli` ← `n8n-cli/SKILL.md`.
- `n8n-workflow-agent` ← `n8n-workflow-agent/SKILL.md`.
- `pdf-processing` ← `pdf-processing/SKILL.md`.
- `planning-exec` ← `planning-exec/SKILL.md`.
- `planning-task` ← `planning-task/SKILL.md`.
- `presentation-skill-pptx` ← `presentation-skill-pptx/SKILL.md`.
- `repo-analysis` ← `repo-analysis/SKILL.md`.
- `revdiff` ← `revdiff/SKILL.md`.
- `review` ← `review/SKILL.md`.
- `sage-metrics-analyst` ← `sage-metrics-analyst-1/SKILL.md`.
- `search-all` ← `search-all/SKILL.md`.
- `search-all/gitlab/SKILL.md` — точная копия `gitlab-cli`, сохранена в составе `search-all`.
- `search-all/jira/SKILL.md` — точная копия `jira-cli`, сохранена в составе `search-all`.
- `wixie-cli` ← `search-all/wixie/SKILL.md`.
- `spec-create` ← `spec-create/SKILL.md`.
- `spec-import` ← `spec-import/SKILL.md`.
- `spec-review` ← `spec-review/SKILL.md`.
- `sql-postgres-optimization` ← `sql-postgres-optimization/SKILL.md`.
- `tbank-performance-review` ← `tbank-performance-review/SKILL.md`.
- `tech-doc-editor` ← `tech-doc-editor/SKILL.md`.
- `tech-docs` ← `tech-docs/SKILL.md`.
- `three-amigo` ← `three-amigo/SKILL.md`.
- `time-cli` ← `time-cli/SKILL.md`.
- `time-messenger` ← `time-messenger/SKILL.md`.
- `time-to-jira` ← `time-to-jira/SKILL.md`.
- `tperf-report-analyzer` ← `tperf-report-analyzer/SKILL.md`.
- `user-using-superpowers` ← `using-superpowers/SKILL.md`.
- `validate-tests` ← `validate-tests-1/SKILL.md`.
- `whiteboard-roadmap-creator` ← `whiteboard-roadmap-creator/SKILL.md`.
- `whiteboard` ← `whiteboard/SKILL.md`.

## Совместимость и зависимости

- Имена `GitLab CLI`, `Jira CLI`, `Search All`, `Wixie CLI` нормализованы в `gitlab-cli`, `jira-cli`, `search-all`, `wixie-cli`.
- Совпадения со старым набором получили `user-brainstorming`, `user-caveman`, `user-using-superpowers`; прежние варианты сохранены.
- Универсальный Jira из папки `jira-1` установлен как `jira`; Spirit CLI-вариант — как `jira-cli`.
- Исправлен YAML-заголовок `sage-metrics-analyst`: описание с двоеточием экранировано.
- В `n8n-workflow-agent` ссылка на отсутствующий `references/SETUP.md` исправлена на предоставленный `references/SETUP_GUIDE.md`.
- Все переданные скрипты, шаблоны, изображения, шрифты, справочные материалы и лицензии скопированы; `.DS_Store` и Python-кэши не импортируются.

Для корпоративных сценариев нужны соответствующие уже настроенные Spirit/dp CLI плагины, MCP или CLI сервиса, доступ к корпоративной сети и авторизация. Time, Jira, GitLab, Sage, Allure, Finedog, n8n и artifact-publish не подключались самим импортом. agterm/revdiff требуют соответствующих локальных приложений/CLI; PPTX/PDF и другие файловые навыки — своих локальных библиотек.

### Неполные зависимости в исходной поставке

- `agterm`: The supplied folder does not contain scripts/show-image.sh; that optional inline-image helper needs to be supplied separately.
- `n8n-workflow-agent`: The n8n MCP server and the companion n8n skills listed by the upstream instructions are runtime prerequisites; they were not installed by this import.
- `tperf-report-analyzer`: The supplied folder does not include the sibling tperf-common/references/{auth,run-identifiers,endpoint-patterns}.md; these shared references must be supplied for those steps.

Эти условия также записаны в начале соответствующего SKILL.md. Отсутствующие файлы не подменялись вымышленными инструкциями. Проверки импорта не подтверждают работу внешних сервисов.

## Проверка и использование

`shared/user-skills-import.json` содержит соответствие каждого исходного определения установленному имени; `UPSTREAM.json` — исходный путь, SHA-256 и адаптации; `skills.lock.json` — контрольные суммы всех файлов.

```bash
node tools/odysseus.mjs sync
node tools/odysseus.mjs sync --check
npm test
```

Копии синхронизируются в `.agents/skills/` подключённых проектов. В Nessy обновите список навыков или начните новую сессию. Установка не запускает команды из SKILL.md и не меняет исходную папку пользователя.
