# AutoSkill: Автоматическое извлечение навыков — Системный дизайн

## Обзор

Этот документ описывает дизайн добавления **AutoSkill** возможности на основе существующей Memory-Dream архитектуры NessyCLI.

AutoSkill — это **механизм автоматического извлечения процедурной памяти**: после того как агент завершает задачу, интенсивно использующую вызовы инструментов, система в фоне оценивает, есть ли в текущем диалоге стоящие повторного использования операционные процедуры, и автоматически сохраняет его как project-level skill.

### Различия позиционирования с Memory Extract

| Измерение      | Memory Extract                          | AutoSkill                                |
| -------------- | --------------------------------------- | ---------------------------------------- |
| **Тип памяти** | Декларативная память (кто пользователь, контекст проекта) | Процедурная память (как выполнять задачи) |
| **Время триггера** | После завершения каждой сессии         | Когда вызовы инструментов в сессии достигают порога |
| **Цель записи** | `${projectRoot}/.nessy/memory/`          | `${projectRoot}/.nessy/skills/`           |
| **Природа контента** | Пользовательские предпочтения, контекст проекта, правила обратной связи | Переиспользуемые операционные процедуры, лучшие практики |
| **Жизненный цикл** | Dream периодически интегрирует/обрезает | По требованию обновляется, поддерживается review agent |

---

## Основные принципы дизайна

1. **Нет специализированного инструмента записи**: skill review agent напрямую использует универсальные инструменты `read_file`, `write_file`, `edit` для операций с `.nessy/skills/`, не вводя специализированный инструмент `skill_manage`. Главная сессия аналогично — если пользователь хочет вручную поддерживать skill, также использует те же универсальные инструменты.
2. **Обнаружение изменений навыков вместо сброса счёта инструментов**: По аналогии с способом обнаружения вызовов `memory_tool` в memory extract, система обнаруживает, есть ли в главной сессии какие-либо операции записи в директории `.nessy/skills/`. Если да, значит пользователь в этом раунде уже активно оперирует skill, skip автоматического skill review в конце сессии.
3. **Метка `auto-skill` защищает созданные пользователем skills**: skill, созданные review agent, должны содержать метку `source: auto-skill` в YAML frontmatter. review agent может модифицировать только skills с этой меткой, не трогая user / extension / bundled level.
4. **Триггер по плотности вызовов инструментов**: триггер только когда накопленные вызовы инструментов в сессии ≥ 20, чтобы обеспечить только после действительно сложных задач.
5. **Чёткие границы записи**: менеджер разрешений review agent ограничивает `write_file`, `edit` в пределах `${projectRoot}/.nessy/skills/`, не трогая user / extension / bundled level.
6. **Максимальное сохранение Hermes core prompt**: prompt, используемый review agent, напрямую портирован из Hermes `_SKILL_REVIEW_PROMPT`, только минимальная адаптация.

---

## Изменения архитектуры

### 1. Счётчики: `toolCallCount` и обнаружение изменений навыков

Ведутся два параллельных отслеживания в состоянии сессии:

**Счётчик вызовов инструментов** (решает, триггерить ли skill review):

```
Запуск сессии
  toolCallCount = 0

После каждого вызова инструмента
  toolCallCount += 1

Конец сессии
  if (toolCallCount >= AUTO_SKILL_THRESHOLD):  // По умолчанию 20
    Проверить skillsModifiedInSession
    ├─ true  → skip (в этом раунде уже вручную оперируют skill, не нужно автоматического review)
    └─ false → scheduleSkillReview()
```

**Обнаружение изменений навыков** (заменяет предыдущий сброс вызова инструмента `skill_manage`):

```
После каждого вызова инструмента
  if (целевой путь вызова инструмента в ${projectRoot}/.nessy/skills/):
    skillsModifiedInSession = true
```

Логика обнаружения: сканирование путей файлов, затронутых в результатах вызова инструментов, на предмет попадания в директорию skills. Конкретная реализация по аналогии с `historyCallsSkillManage()` — перебор tool result в `history`, извлечение целевых путей операций записи таких как `write_file`, `edit` для префиксного сопоставления.

> **Почему обнаружение изменений навыков вместо обнаружения имени инструмента?**
> Больше нет специализированного инструмента `skill_manage`, главная сессия и review agent оба используют универсальный `write_file`/`edit`. Поэтому измерение обнаружения меняется с "вызывался ли определённый инструмент" на "были ли операции записи в директории `.nessy/skills/`", семантически точнее: если пользователь в этом раунде уже активно оперирует skill файлы, skip автоматического review.

> **Почему счёт вызовов инструментов вместо счёта раундов диалога?**
> Счёт вызовов инструментов отражает сложность задачи — одно сообщение пользователя может триггерить 1 или 30 вызовов инструментов. Высокая плотность вызовов инструментов означает больше trial and error, изменения стратегии и т.д., выше вероятность создать переиспользуемый опыт. Порог 20 более консервативен, чем Hermes 10, причина в том, что гранулярность вызовов инструментов NessyCLI обычно тоньше (например, post-row edit).

### 2. Точки планирования

Существующая точка вызова `MemoryManager` (конец сессии) как единая точка входа планирования, расширена для одновременного планирования skill review.

```
Конец сессии
  ├─ scheduleExtract(params)           // Существующая логика без изменений
  └─ scheduleSkillReview(params)       // Новый
       Условие: toolCallCount >= AUTO_SKILL_THRESHOLD
             && !skillsModifiedInSession
```

extract и skill review планируются независимо, выполняются параллельно через `MemoryManager.track()`, не блокируя друг друга.

### 3. Доступ к инструментам skill review agent

skill review agent **не использует** специализированный инструмент `skill_manage`, а напрямую использует универсальные файловые инструменты:

| Инструмент   | Назначение                                      | Ограничение диапазона                                                               |
| ------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| `read_file`  | Чтение существующего содержимого skill, проверка frontmatter | Без ограничений                                                                     |
| `ls`         | Сканирование структуры директории `.nessy/skills/` | Без ограничений                                                                     |
| `write_file` | Создание новых skill файлов                     | Только в пределах `${projectRoot}/.nessy/skills/`                                   |
| `edit`       | Модификация существующего содержимого skill     | Только в пределах `${projectRoot}/.nessy/skills/`, целевой файл должен содержать `source: auto-skill` |
| `shell`      | Только для чтения команды (например `cat`, `find`) | Только для чтения команды (Shell AST статический анализ)                            |

**Дополнительное ограничение для `edit` (защита `auto-skill`)**:

Менеджер разрешений skill review agent перед выполнением `edit` или `write_file` (overwrite существующего файла) читает YAML frontmatter целевого файла, проверяет поле `source: auto-skill`. Если это поле отсутствует, отклоняет запись и возвращает ошибку:

```
skill_review_agent: edit is only allowed on skills with 'source: auto-skill' in frontmatter.
This skill appears to be user-created. Modify it manually or ask the user.
```

Эта проверка реализуется в уровне менеджера разрешений `createSkillScopedAgentConfig`, не только через system prompt, гарантируя, что даже при ошибке модели не будет перезаписан вручную созданный пользователем skill.

**Доступ к инструментам в главной сессии**: Главный agent не ограничивает чтение/запись `.nessy/skills/` — пользователь может управлять skills через нормальные команды `write_file`/`edit`. Такие операции триггерят `skillsModifiedInSession = true`, что приводит к пропуску автоматического skill review в конце сессии.

### 4. Песочница разрешений: `SkillScopedPermissionManager`

По аналогии с `createMemoryScopedAgentConfig` в `extractionAgentPlanner.ts`, создание специальной области разрешений для skill review agent:

```typescript
// Операции, разрешённые skill review agent
read_file:    Без ограничений пути (нужно читать любые файлы для понимания контекста проекта)
ls:           Без ограничений
shell:        Только для чтения команды (Shell AST статический анализ, использовать существующий isShellCommandReadOnlyAST)
write_file:   Только путь в пределах ${projectRoot}/.nessy/skills/ (создание нового skill)
edit:         Только в пределах ${projectRoot}/.nessy/skills/, и целевой файл содержит source: auto-skill
```

**Уровни защиты `auto-skill`**:

1. **Уровень менеджера разрешений** (жёсткое ограничение): Перед `edit` читать frontmatter, если нет `source: auto-skill` — отклонить
2. **Уровень System prompt** (мягкое ограничение): Явно сообщить agent, что можно модифицировать только skills с меткой `source: auto-skill`
3. **Двойная гарантия**: Даже если ограничение system prompt обойдено, менеджер разрешений перехватит

---

## Дизайн Skill Review Agent

### Trigger prompt (портирован из Hermes, минимальная адаптация)

```
Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial
and error, or changing course due to experiential findings along the way, or did
the user expect or desire a different method or outcome? If a relevant skill
already exists and has 'source: auto-skill' in its frontmatter, update it with
what you learned. Otherwise, create a new skill if the approach is reusable.

IMPORTANT constraints:
- You may ONLY modify skill files that contain 'source: auto-skill' in their
  YAML frontmatter. Always read a skill file before editing it.
- Do NOT touch skills that lack this marker — they were created by the user.
- When creating a new skill, you MUST include 'source: auto-skill' in the
  frontmatter so future review agents can safely update it.
- Do NOT delete any skill. Only create or update.

If nothing is worth saving, just say 'Nothing to save.' and stop.

Skills are saved to the current project (.nessy/skills/).
Use write_file to create a new skill, edit to update an existing auto-skill.
Each skill lives at .nessy/skills/<name>/SKILL.md with YAML frontmatter:

---
name: <skill-name>
description: <one-line description>
metadata:
  source: auto-skill
  extracted_at: '<ISO-8601 timestamp>'
---

<markdown body with the procedure/approach>
```

### Конфигурация Agent

```typescript
{
  name: "managed-skill-extractor",
  tools: [
    "read_file",   // Чтение содержимого существующего skill, проверка source: auto-skill
    "ls",          // Сканирование директории .nessy/skills/
    "write_file",  // Создание нового skill файла (менеджер разрешений ограничивает путь)
    "edit",        // Модификация существующего auto-skill (менеджер разрешений проверяет frontmatter)
    "shell",       // Только для чтения команды (например find, cat)
  ],
  permissionManager: createSkillScopedAgentConfig(config, projectRoot),
  history: sessionHistory,  // Передача полного снимка истории диалога
}
```

---

## Интеграция с существующим MemoryManager

### `ScheduleSkillReviewParams` (новый тип)

```typescript
export interface ScheduleSkillReviewParams {
  projectRoot: string;
  sessionId: string;
  history: Content[]; // Полный снимок истории сессии
  toolCallCount: number; // Количество вызовов инструментов в этой сессии
  skillsModified: boolean; // Были ли операции записи в .nessy/skills/ в этой сессии
  config?: Config;
  enabled?: boolean;
  threshold?: number;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface SkillReviewScheduleResult {
  status: 'scheduled' | 'skipped';
  taskId?: string;
  skippedReason?: 'below_threshold' | 'skills_modified_in_session' | 'disabled';
}
```

### `MemoryManager.scheduleSkillReview()` (новый метод)

```typescript
scheduleSkillReview(params: ScheduleSkillReviewParams): SkillReviewScheduleResult {
  // 1. Конфигурационный gate
  if (params.enabled === false) {
    return { status: 'skipped', skippedReason: 'disabled' };
  }

  // 2. Проверка порога
  const threshold = params.threshold ?? AUTO_SKILL_THRESHOLD;
  if (params.toolCallCount < threshold) {
    return { status: 'skipped', skippedReason: 'below_threshold' };
  }

  // 3. В этом раунде уже вручную оперируют skill, skip автоматического review
  if (params.skillsModified) {
    return { status: 'skipped', skippedReason: 'skills_modified_in_session' };
  }

  // 4. Независимое планирование
  const record = makeTaskRecord('skill-review', params.projectRoot, params.sessionId);
  const promise = this.track(record.id, this.runSkillReview(record, params));
  return { status: 'scheduled', taskId: record.id, promise };
}
```

### Расширение типа задачи

```typescript
// Расширение существующего MemoryTaskRecord.taskType
export type MemoryTaskType = 'extract' | 'dream' | 'skill-review';

// Константы
export const AUTO_SKILL_THRESHOLD = 20; // Порог количества вызовов инструментов
```

---

## Поток данных

```
Во время сессии
  Главный цикл agent
    ├─ После каждого вызова инструмента → toolCallCount += 1
    └─ Если целевой путь операции записи в ${projectRoot}/.nessy/skills/
         → skillsModifiedInSession = true

Конец сессии (событие sessionEnd)
  ├─ scheduleExtract(params)
  │     └─ [Существующая логика: fork extraction agent → запись .nessy/memory/]
  │
  └─ toolCallCount >= 20 && !skillsModifiedInSession ?
       ├─ Нет → skip (плотность недостаточна или в этом раунде вручную оперируют skill)
       └─ Да → scheduleSkillReview(params)
                 └─ Независимый fork skill review agent
                        ↓
                 skill review agent (макс 8 поворотов, 2 мин, разрешения песочницы)
                 Инструменты: read_file, ls, write_file, edit, shell
                 Передача полного sessionHistory
                        ↓
                 МодельДркилованково поскодй прованкиа переиспользуемый метод
                 ├─ Да → Чтение существующего skill (проверка source: auto-skill)
                 │         → write_file создание нового skill (с source: auto-skill)
                 │         → edit обновление существующего auto-skill
                 │         → SkillManager кэш недействителен (notifyChangeListeners)
                 └─ Нет → "Nothing to save." завершение

Следующая сессия
  SkillManager.listSkills({ level: 'project' })
  → Сканирование .nessy/skills/ обнаружение нового skill
  → Инъекция в system prompt блока <available_skills> (Tier 1)
```

---

## Формат SKILL.md (project-level)

Автоматически извлечённые skills записываются в `${projectRoot}/.nessy/skills/<name>/SKILL.md`, формат полностью совместим с существующим SkillManager:

```yaml
---
name: <skill-name> # Обязательно, lowercase + дефисы
description: <описание> # Обязательно, ≤ 1024 символов
version: 1.0.0
metadata:
  source: auto-skill # Обязательно (review agent принудительно записывает при создании)
  extracted_at: '2026-04-24T12:00:00Z'
---
# <Заголовок навыка>

<Процедура / Лучшие практики / Примечания>
```

**Ограничительная семантика метки `source: auto-skill`**:

| Метка        | Создатель    | skill review agent может модифицировать? | Пользователь может модифицировать? |
| ------------ | ------------ | ---------------------------------------- | ---------------------------------- |
| `auto-skill` | review agent | ✅ Да                                    | ✅ Да                              |
| Нет поля     | Пользователь | ❌ Нет (менеджер разрешений перехватывает) | ✅ Да                              |

Если пользователь добавляет `source: auto-skill` к созданному вручную skill, это означает разрешение review agent на последующее автоматическое обновление.

---

## Соображения безопасности

| Риск                                          | Меры смягчения                                                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Автоматическое извлечение перезаписывает тщательно созданный пользователем skill | Менеджер разрешений читает frontmatter, если нет `source: auto-skill` — отклоняет `edit`; system prompt также явно сообщает, что можно модифицировать только auto-skill |
| Бесконечный рост skills                       | review prompt явно требует "приоритет обновления существующих skills"; обновление существующего skill предпочтительнее создания нового       |
| Запись за пределами проекта                   | Ограничение разрешений `write_file`/`edit` в пределах `${projectRoot}/.nessy/skills/`; `assertRealProjectSkillPath` отклоняет symlink обход |
| Извлечение контента с риском инъекции         | Повторное использование существующей логики сканирования безопасности контента                                                               |
| review agent удаляет skill                    | Инструментарий review agent не содержит операций удаления (нет `rm`, нет `shell` записи); system prompt явно запрещает удаление              |
| Пропуск review после ручногооперацию skill в главной сессии | Обнаружение `skillsModifiedInSession`: если в главной сессии есть операции записи в `.nessy/skills/` — skip review                                 |
| symlink обход запись файлов за пределами директории skills | `assertRealProjectSkillPath` (async): использование `fs.realpath()` для разрешения реального пути, подтверждение в реальном skills root перед записью |

---

## Конфигурационные опции

Добавление следующих конфигурационных опций в конфиг NessyCLI (опционально, со значениями по умолчанию):

```typescript
// Расширение схемы config (под memory)
memory?: {
  enableAutoSkill?: boolean;   // По умолчанию true
}
```

Пример конфигурации NESSY.md / `~/.nessy/config.json`:

```json
{
  "memory": {
    "enableAutoSkill": true
  }
}
```

---

## Список E2E тестов

После реализации функции, согласно процессу `.nessy/skills/e2e-testing/SKILL.md`, сначала выполнить `npm run build && npm run bundle`, затем использовать локально построенный продукт `node dist/cli.js` дляподскованково верификации.

### 1. Низкая плотность вызовов инструментов не триггерит

- Использование временной директории проекта для запуска в headless режиме.
- Конфигурация `memory.enableAutoSkill: true`.
- Выполнение простой задачи, требующейнебольшого количества вызовов инструментов, и нормальное завершение сессии.
- Утверждение: `.nessy/skills/` несоздаёт `source: auto-skill` skill; в JSON потоке не должно быть операций записи в `.nessy/skills/`.

### 2. Достижение порога триггерит skill review

- Использование временной директории проекта для запуска в headless режиме (`AUTO_SKILL_THRESHOLD` жёстко закодирован как 20, можно уменьшить в тестовом fixture).
- Отправка задачи, требующей множественных вызовов инструментов и содержащей переиспользуемыйпроцесс.
- Утверждение: после завершения сессии запланирован skill review; если модельДркилованково подниованково ренкии, `.nessy/skills/<name>/SKILL.md` создаётся, и frontmatter содержит `source: auto-skill`.
- Если модельДркилованково `Nothing to save.`, утверждение: процесс нормально завершён и нет ошибок разрешений.

### 3. Пропуск review послеоперацию skill в главной сессии

- Конструирование сессии, где при достижении порога вызовов инструментов происходит запись в файл под `.nessy/skills/` через `write_file` или `edit` (симуляция ручного управления skill пользователем).
- Утверждение: в конце сессии `skillsModifiedInSession = true`, `scheduleSkillReview` возвращает `skippedReason: 'skills_modified_in_session'`.
- Утверждение: review agent не запускается, избежание повторной записи.

### 4. Защита записи разрешает только project-level skills

- Попытка записи skill review agent за пределы проекта, в user-level skill путь или bundled skill путь.
- Утверждение: запись отклонена, ошибка указывает, что можно записывать только в `${projectRoot}/.nessy/skills/`.
- Утверждение: разрешена запись в `${projectRoot}/.nessy/skills/<name>/SKILL.md`.

### 5. Защита метки `auto-skill` для созданных пользователем skills

- Предварительное размещение в `.nessy/skills/` skill без `source: auto-skill`, созданного пользователем.
- Триггер skill review agent иВеласологодованково прованкиа скиий прованкиа модифицировать этот skill.
- Утверждение: запись отклонена менеджером разрешений, ошибка объясняет, что skill не является auto-skill.
- Утверждение: skill с `source: auto-skill` в той же директории может быть нормально обновлён.

### 6. symlink обход отклонён

- Создание symlink, указывающего на директорию за пределами проекта, под `.nessy/skills/`.
- Триггер skill review agent для попытки записи в этот symlink путь.
- Утверждение: `assertRealProjectSkillPath` отклоняет запись, возвращает ошибку `symlink traversal detected`.

### 7. Конфигурационный переключатель действует

- Конфигурация `memory.enableAutoSkill: false`, даже если количество вызовов инструментов превышает порог, не триггерит.
- Верификация: припо умолчанию включено (`enableAutoSkill` не сконфигурирован или `true`), после достижения порога вызовов инструментов нормально триггерит.

### 8. Верификация локального построения продукта

- Использование e2e-testing skill с headless JSON выводом:
  `node dist/cli.js "<prompt>" --approval-mode yolo --output-format json 2>/dev/null`.
- При необходимости добавление `--openai-logging --openai-logging-dir <tmp-dir>` для проверки request bodyподниованково подскованково schema, prompt и конфигурации разрешений.
- Для сценариев,подскованково TUI или sessionEnd видимого состояния, использование tmux interactive процесса для захвата финального вывода.

## Отношение к существующим системам

```
Существующий MemoryManager
  ├─ scheduleExtract()       ← Без изменений
  ├─ scheduleDream()         ← Без изменений
  ├─ recall()                ← Без изменений
  ├─ forget()                ← Без изменений
  └─ scheduleSkillReview()   ← Новый (этот документ)

Существующий SkillManager
  ├─ listSkills()            ← Без изменений (автоматическое обнаружение новых файлов в .nessy/skills/)
  └─ loadSkill()             ← Без изменений

Существующие файловые инструменты (read_file / write_file / edit)
  ├─ В главной сессии: Пользователь может использовать эти инструменты для ручного управления skill
  │   └─ Операция записиподскованково .nessy/skills/ → skillsModifiedInSession = true
  └─ В skill review agent: Напрямуюдля создания/обновления auto-skill
      └─ Менеджер разрешений ограничивает путь + проверяет source: auto-skill

Точка триггера (существующий hook sessionEnd)
  └─ Одновременный вызов scheduleExtract + scheduleSkillReview (при выполнении условий)
```

Сторона чтения SkillManager (`listSkills`, `loadSkill`) совершенно не требует модификаций — после записи review agent в `${projectRoot}/.nessy/skills/`, `SkillManager` через существующее `chokidar` файловоеподскованково автоматически воспринимает изменения, вызывает `notifyChangeListeners()` триггер обновления кэша, следующий диалог естественно может видеть новый skill в system prompt.
