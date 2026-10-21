# Ребрендинг upstream → Nessy

Скрипт меняет названия, пути, ссылки и графику по конфигу `nessy.json`.

## GitLab CI

В **Run pipeline** выберите ветку с этим скриптом и задайте:

- `PIPELINE_MODE=rebrand`;
- `REBRAND_UPSTREAM_REF=upstream/0.19.1` — нужную ветку `upstream/*`.

CI выполняет ребрендинг, сборку, тесты и пробную установку npm-архива.
Запускаются полные JS/TS unit-наборы npm-пакетов и скриптов, проверки
Desktop-моделей, карточки Insights и браузерных примеров, затем smoke-тест CLI.
После успеха создаёт ветку `nessy/<версия>`; архивы и отчёты сохраняет в артефактах.
Для публикации нужна CI-переменная `GITLAB_NESTOR_DEVELOPER` и право аккаунта создавать ветки.
Существующая ветка с другим коммитом не перезаписывается: для пересборки её нужно удалить.
Пакеты в реестр не публикуются, Desktop не упаковывается.

В итоговую ветку копируется `gitlab-ci.yml` как корневой `.gitlab-ci.yml`:
сборка npm-пакетов и CLI bundle, JS/TS unit-тесты и ESLint.
Корневой `.gitlab-ci-compliance.yml` переносится из ветки контроллера без изменений:
он подключает корпоративные проверки и наш `.gitlab-ci.yml`.
Пайплайн запускается при push, в MR и через **Run pipeline**, без релизов.
Сборка и JUnit-отчёты сохраняются в артефактах. Первый запуск — после публикации ветки.
Для уже созданной ветки нужно пересоздать её новым rebrand-пайплайном.

## Локально

Из корня репозитория, в отдельной рабочей копии upstream:

```sh
git worktree add --detach /tmp/nessy-rebrand ac3c8ea131d262dd7ef98f4decb581788b69edda
node scripts/rebrand/rebrand.mjs --root /tmp/nessy-rebrand --mode plan
node scripts/rebrand/rebrand.mjs --root /tmp/nessy-rebrand --mode apply
node scripts/rebrand/rebrand.mjs --root /tmp/nessy-rebrand --mode check
```

`plan` показывает изменения, `apply` записывает их, `check` проверяет результат.
Для JSON-отчёта добавьте `--report /tmp/rebrand-report.json`.

## Конфиги

`nessy.json` подключает файлы правил:

- `config/replacements.json` — замены текста и путей;
- `config/urls.json` — замены ссылок до применения исключений;
- `config/exceptions.json` — что сохраняем: ID моделей, протоколы, авторство и т. д.;
- `config/patches.json` — замены фрагментов: `from` → `to` или `toFile`, `count` — число вхождений;
- `config/assets.json` — замены файлов: `path`, SHA256 исходника, `replaceWith`;
- `config/remote-media.json` — что делать с внешними картинками и видео;
- `nessy-mentions.json` — известные оставшиеся упоминания Qwen.

Файлы для подстановки лежат в `assets/`; их происхождение — в `assets/README.md`.
Пути `replaceWith` и `toFile` считаются от каталога `nessy.json`.

Новые остаточные упоминания, изменившийся фрагмент патча или SHA256 останавливают
запуск. Для нового upstream правила нужно проверить и при необходимости обновить.
Список известных упоминаний меняется вручную после проверки, CI его не расширяет.

Автообновления и онлайн-установка пока отключены. Временные подмены README,
установщиков и тестов помечены `_comment` в `assets.json` и `patches.json`;
позже их заменят fork-патчи. Тесты проверяют поведение заглушек, а не пропускаются.

## Навыки для работы с движком

- [rebrand-edit](../../.nessy/skills/rebrand-edit/SKILL.md) — добавить или изменить правило, ссылку, ассет или исключение.
- [rebrand-verify](../../.nessy/skills/rebrand-verify/SKILL.md) — проверить новую версию upstream, разобрать ошибки и прогнать сборку и тесты.
