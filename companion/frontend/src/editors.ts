import { call, lines, short, projectOptions as projects, useApp } from './runtime';
export function scenarioEditor(app: any, data: any, t: any, row: any) {
  const { edit: editor, detail, collection, project } = app;
  const collectionOptions = () => app.catalogs.collections.map((c: any) => [c.id, c.name]);
  const projectOptions = () => projects(app);
  const kinds = [
    ['fact', 'Факты'],
    ['hypothesis', 'Гипотезы'],
    ['check', 'Проверки'],
    ['question', 'Нерешённые вопросы'],
  ];
  editor(
    t.name,
    [
      { name: 'title', label: 'Название', required: true, value: row?.title || t.name, max: 160 },
      {
        name: 'project',
        label: 'Проект',
        type: 'select',
        value: row?.project || (data.projects?.length === 1 ? data.projects[0].id : ''),
        options: [['', 'Выбрать позже'], ...(data.projects || []).map((p: any) => [p.id, p.name])],
      },
      {
        name: 'input',
        label: 'Что нужно сделать?',
        type: 'textarea',
        required: true,
        value: row?.input || (t.id === 'tutorial' ? t.inputs : ''),
        max: 12000,
        wide: true,
      },
      {
        name: 'output',
        label: 'Результат',
        type: 'textarea',
        value: row?.output,
        max: 16000,
        wide: true,
      },
      ...t.steps.map((step: any, index: any) => ({
        name: 'step' + index,
        label: step,
        type: 'checkbox',
        value: row?.steps[index]?.done || false,
      })),
      ...kinds.flatMap(([kind, label]: any) => [
        {
          name: kind,
          label,
          type: 'textarea',
          value: row?.evidence
            .filter((e: any) => e.kind === kind)
            .map((e: any) => e.text)
            .join('\n'),
          max: 4000,
          wide: true,
        },
        {
          name: kind + 'Source',
          label: 'Источник / результат: ' + label.toLowerCase(),
          value: row?.evidence.find((e: any) => e.kind === kind)?.source,
          max: 2000,
          wide: true,
        },
      ]),
      {
        name: 'status',
        label: 'Статус',
        type: 'select',
        value: row?.status || 'draft',
        options: [
          ['draft', 'Подготовка'],
          ['review', 'На проверке'],
          ['accepted', 'Принято пользователем'],
          ['cancelled', 'Отменено'],
        ],
      },
      { name: 'owner', label: 'Владелец / ответственный', value: row?.owner, max: 200 },
      ...(t.id === 'release'
        ? [
            { name: 'freezeDate', label: 'Код-фриз', type: 'date', value: row?.freezeDate },
            { name: 'releaseDate', label: 'Дата релиза', type: 'date', value: row?.releaseDate },
          ]
        : []),
      {
        name: 'rating',
        label: 'Полезность результата',
        type: 'select',
        value: row?.rating || 0,
        options: [
          [0, 'Без оценки'],
          [1, '1 — не помог'],
          [2, '2 — мало пользы'],
          [3, '3 — полезно'],
          [4, '4 — очень полезно'],
          [5, '5 — отличный результат'],
        ],
      },
      {
        name: 'feedbackReason',
        label: 'Основная причина оценки',
        type: 'select',
        value: row?.feedbackReason || '',
        options: [
          ['', 'Не указана'],
          ['context', 'Контекст и источники'],
          ['access', 'Доступ к инструментам'],
          ['quality', 'Качество ответа'],
          ['usability', 'Удобство работы'],
          ['other', 'Другое'],
        ],
      },
      {
        name: 'assistedMinutes',
        label: 'Полное время с AI, включая проверку, минут',
        type: 'number',
        value: row?.assistedMinutes,
      },
      {
        name: 'feedback',
        label: 'Что помогло / что исправить',
        type: 'textarea',
        value: row?.feedback,
        max: 2000,
        wide: true,
      },
      {
        name: 'manualMinutes',
        label: 'Обычное время вручную, минут (если измерено)',
        type: 'number',
        value: row?.manualMinutes,
      },
      {
        name: 'reviewMinutes',
        label: 'Время проверки и исправлений, минут',
        type: 'number',
        value: row?.reviewMinutes,
      },
    ].map((f: any) => ({
      ...f,
      group: ['project', 'input'].includes(f.name)
        ? undefined
        : f.name === 'title'
          ? 'Название и сроки'
          : ['output', 'status'].includes(f.name)
            ? 'Результат'
            : f.name.startsWith('step') ||
                kinds.some(([k]: any) => f.name === k || f.name === k + 'Source')
              ? 'Проверка результата'
              : ['owner', 'freezeDate', 'releaseDate'].includes(f.name)
                ? 'Название и сроки'
                : 'Оценка и замеры (необязательно)',
    })),
    (v: any) =>
      call('scenarioSave', {
        ...v,
        id: row?.id,
        template: t.id,
        expectedRevision: row?.revision || 0,
        steps: t.steps.map((name: any, index: any) => ({ name, done: v['step' + index] })),
        evidence: kinds
          .filter(([kind]: any) => v[kind]?.trim())
          .map(([kind]: any) => ({ kind, text: v[kind], source: v[kind + 'Source'] })),
      }),
    {
      submit: row ? 'Сохранить изменения' : 'Создать задачу',
      after: () => app.refresh(),
      hint: 'Опишите задачу своими словами. Этапы уже подготовлены; результат и проверки можно добавить после работы Nessy.',
    },
  );
}

export function memoryEditor(app: any, e: any = null) {
  const { edit: editor, detail, collection, project } = app;
  const collectionOptions = () => app.catalogs.collections.map((c: any) => [c.id, c.name]);
  const projectOptions = () => projects(app);
  if (e?.status === 'merged') {
    detail('Объединённая исходная запись', e.text + '\n\nИсточники:\n' + e.sources.join('\n'));
    return;
  }
  editor(
    e ? 'Проверка знания' : 'Новое знание',
    [
      { name: 'title', label: 'Заголовок', required: true, max: 160, value: e?.title },
      {
        name: 'text',
        label: 'Факт или полезный итог',
        type: 'textarea',
        required: true,
        wide: true,
        rows: 12,
        value: e?.text,
      },
      {
        name: 'collection',
        label: 'Каталог знаний',
        type: 'select',
        value: e?.collection || collection,
        options: collectionOptions(),
      },
      {
        name: 'project',
        label: 'Проект',
        type: 'select',
        value: e?.project || project.replace(/^project:/, ''),
        options: projectOptions(),
      },
      {
        name: 'sources',
        label: 'Источники, по одному на строку',
        type: 'textarea',
        value: e?.sources.join('\n'),
        rows: 3,
      },
    ],
    async (v: any) => {
      if (e)
        await call('memoryEdit', {
          id: e.id,
          expectedUpdatedAt: e.updatedAt,
          ...v,
          sources: lines(v.sources),
          action: e.status === 'pending' ? 'approve' : 'edit',
        });
      else {
        const entry = await call('memoryCapture', { ...v, sources: lines(v.sources) });
        await call('memoryEdit', { id: entry.id, action: 'approve' });
      }
    },
    {
      submit: e && e.status !== 'pending' ? 'Сохранить исправление' : 'Подтвердить знание',
      after: () => app.refresh(),
      hint: 'Проверьте формулировку и основания. После подтверждения запись станет доступна поиску Nessy.',
    },
  );
}

export async function decisionEditor(app: any, e: any = null) {
  const { edit: editor, detail, collection, project } = app;
  const collectionOptions = () => app.catalogs.collections.map((c: any) => [c.id, c.name]);
  const projectOptions = () => projects(app);
  const chats = await call('chatList', { limit: 100 }),
    boards = await call('boardState');
  const chatChoices = chats.data.map((c: any) => [c.id, c.title]),
    taskChoices = boards.boards.flatMap((b: any) =>
      b.tasks.map((t: any) => [t.id, b.name + ' · ' + t.title]),
    );
  for (const id of e?.chatIds || [])
    if (!chatChoices.some((c: any) => c[0] === id)) chatChoices.push([id, 'Ранее связанный чат']);
  editor(
    e ? 'Решение: ' + e.title : 'Записать решение',
    [
      { name: 'title', label: 'Заголовок', required: true, value: e?.title, max: 160 },
      {
        name: 'status',
        label: 'Статус',
        type: 'select',
        value: e?.status || 'accepted',
        options: [
          ['proposed', 'Предложено'],
          ['accepted', 'Принято'],
          ['superseded', 'Заменено'],
        ],
      },
      {
        name: 'text',
        label: 'Что решили',
        type: 'textarea',
        required: true,
        wide: true,
        value: e?.text,
        max: 16000,
      },
      {
        name: 'reason',
        label: 'Почему выбрали этот вариант',
        type: 'textarea',
        required: true,
        wide: true,
        value: e?.reason,
        max: 4000,
      },
      {
        name: 'collection',
        label: 'Каталог знаний',
        type: 'select',
        value: e?.collection || collection,
        options: collectionOptions(),
      },
      {
        name: 'project',
        label: 'Проект',
        type: 'select',
        value: e?.project || project.replace(/^project:/, ''),
        options: projectOptions(),
      },
      {
        name: 'sources',
        label: 'Источники, по одному на строку',
        type: 'textarea',
        value: e?.sources.join('\n'),
      },
      {
        name: 'checks',
        label: 'Фактические проверки, по одной на строку',
        type: 'textarea',
        value: e?.checks.join('\n'),
      },
      {
        name: 'chatIds',
        label: 'Связанные чаты',
        type: 'multi',
        value: e?.chatIds || [],
        options: chatChoices,
      },
      {
        name: 'taskIds',
        label: 'Связанные задачи',
        type: 'multi',
        value: e?.taskIds || [],
        options: taskChoices,
      },
    ],
    (v: any) =>
      call('decisionSave', {
        ...v,
        id: e?.id,
        expectedUpdatedAt: e?.updatedAt,
        sources: lines(v.sources),
        checks: lines(v.checks),
        chatIds: v.chatIds,
        taskIds: v.taskIds,
      }),
    {
      after: () => app.refresh(),
      hint: 'Принятое решение публикуется в графе. Предложение остаётся в журнале решений до вашего подтверждения.',
    },
  );
}

export function profileEditor(app: any, state: any, p: any = null) {
  const { edit: editor, detail, collection, project } = app;
  const collectionOptions = () => app.catalogs.collections.map((c: any) => [c.id, c.name]);
  const projectOptions = () => projects(app);
  editor(
    'Рабочий профиль',
    [
      { name: 'name', label: 'Название', required: true, value: p?.name, max: 100 },
      {
        name: 'memory',
        label: 'Автоматически собирать входящие знания',
        type: 'checkbox',
        value: p?.memory ?? true,
      },
      {
        name: 'skillNames',
        label: 'Навыки',
        type: 'multi',
        wide: true,
        value:
          p?.skillNames || state.skills.filter((s: any) => s.automatic).map((s: any) => s.name),
        options: state.skills.map((s: any) => [
          s.name,
          s.name + ' — ' + short(s.descriptionRu, 85),
        ]),
      },
      {
        name: 'mcpNames',
        label: 'MCP-серверы',
        type: 'multi',
        wide: true,
        value: p?.mcpNames || state.servers.filter((s: any) => s.enabled).map((s: any) => s.name),
        options: state.servers.map((s: any) => [s.name, s.name]),
      },
    ],
    (v: any) => call('toolProfileSave', { ...v, id: p && !p.preset ? p.id : undefined }),
    {
      after: () => app.refresh(),
      hint: 'Сохранение профиля не меняет Nessy. Применение доступно отдельно после предпросмотра.',
    },
  );
}

export async function customScenarioEditor(app: any, row: any = {}) {
  const { edit: editor, detail, collection, project } = app;
  const collectionOptions = () => app.catalogs.collections.map((c: any) => [c.id, c.name]);
  const projectOptions = () => projects(app);
  const catalog = await call('taskCatalog');
  const skillChoices = catalog.skills
      .filter((s: any) => s.enabled)
      .map((s: any) => [s.name, s.name]),
    mcpChoices = catalog.servers.filter((s: any) => s.enabled).map((s: any) => [s.name, s.name]);
  for (const n of row.skillNames || [])
    if (!skillChoices.some((x: any) => x[0] === n)) skillChoices.push([n, n + ' — недоступен']);
  for (const n of row.mcpNames || [])
    if (!mcpChoices.some((x: any) => x[0] === n)) mcpChoices.push([n, n + ' — недоступен']);
  editor(
    row.id ? 'Изменить сценарий' : 'Свой сценарий',
    [
      { name: 'name', label: 'Название', required: true, value: row.name, max: 160, wide: true },
      {
        name: 'description',
        label: 'Короткое описание',
        value: row.description || row.inputs,
        max: 1000,
        wide: true,
      },
      {
        name: 'instructions',
        label: 'Что должен делать Nessy',
        type: 'textarea',
        required: true,
        value: row.instructions || row.rule,
        max: 12000,
        wide: true,
      },
      {
        name: 'steps',
        label: 'Этапы — по одному на строке',
        type: 'textarea',
        value: (row.steps || []).join('\n'),
        wide: true,
        group: 'Этапы и инструменты',
      },
      {
        name: 'skillNames',
        label: 'Навыки',
        type: 'multi',
        value: row.skillNames || [],
        options: skillChoices,
        group: 'Этапы и инструменты',
      },
      {
        name: 'mcpNames',
        label: 'MCP',
        type: 'multi',
        value: row.mcpNames || [],
        options: mcpChoices,
        group: 'Этапы и инструменты',
      },
      {
        name: 'development',
        label: 'Разрешить разработку в защищённом worktree',
        type: 'checkbox',
        value: row.development || false,
        group: 'Этапы и инструменты',
      },
    ],
    (v: any) =>
      call('customScenarioSave', {
        ...v,
        id: row.id,
        expectedRevision: row.revision || 0,
        steps: lines(v.steps),
      }),
    {
      after: () => app.refresh(),
      hint: 'Сценарий сохранится в Companion. Инструменты применяются при запуске в Nessy. Черновик из ответа модели проверьте перед сохранением.',
    },
  );
}

export function agentDefinitionEditor(app: any, data: any, d: any = null, copy: any = false) {
  const { edit: editor, detail, collection, project } = app;
  const collectionOptions = () => app.catalogs.collections.map((c: any) => [c.id, c.name]);
  const projectOptions = () => projects(app);
  const existing = d && !copy;
  const v = d || {
    name: '',
    role: 'specialist',
    title: '',
    description: '',
    instructions: '',
    rules:
      'Соблюдай порученную область и права Nessy. Не раскрывай секреты. Не делегируй повторно.',
    output: 'Результат; источники; проверки и фактические исходы; блокеры.',
    tools: ['Read', 'Grep', 'Glob'],
    deniedTools: [],
    mcpServers: [],
    model: 'inherit',
    approvalMode: 'default',
    maxTurns: 30,
    maxMinutes: 15,
    color: 'blue',
  };
  editor(
    existing ? 'Настроить: ' + d.title : copy ? 'Копия: ' + d.title : 'Создать субагента',
    [
      {
        name: 'name',
        label: 'ID для вызова в Nessy',
        readOnly: existing,
        required: true,
        max: 100,
        value: copy ? v.name + '-copy' : v.name,
        hint: 'Строчные латинские буквы, цифры и дефисы.',
      },
      {
        name: 'title',
        label: 'Название роли',
        required: true,
        max: 100,
        value: copy ? v.title + ' · копия' : v.title,
      },
      {
        name: 'role',
        label: 'Роль в плане этапов',
        required: true,
        max: 80,
        value: copy ? v.role + '-copy' : v.role,
        hint: 'В плане также можно указать ID субагента.',
      },
      {
        name: 'description',
        label: 'Когда делегировать этому специалисту',
        type: 'textarea',
        wide: true,
        required: true,
        rows: 3,
        max: 1500,
        value: v.description,
      },
      {
        name: 'instructions',
        label: 'Указания: цель и порядок работы',
        type: 'textarea',
        wide: true,
        required: true,
        rows: 7,
        max: 16000,
        value: v.instructions,
      },
      {
        name: 'rules',
        label: 'Правила и запреты поведения',
        type: 'textarea',
        wide: true,
        rows: 5,
        max: 10000,
        value: v.rules,
      },
      {
        name: 'fileScope',
        label: 'Область файлов — инструкция',
        type: 'textarea',
        wide: true,
        rows: 3,
        max: 4000,
        value: v.fileScope,
        hint: 'Например src/import/**. Текстовое ограничение, а не файловая песочница.',
      },
      {
        name: 'output',
        label: 'Формат результата',
        type: 'textarea',
        wide: true,
        required: true,
        rows: 3,
        max: 4000,
        value: v.output,
      },
      {
        name: 'tools',
        label: 'Доступные встроенные инструменты',
        type: 'multi',
        value: v.tools,
        options: data.tools,
        hint: 'Bash может изменять файлы и обращаться к сети. Выберите хотя бы один инструмент.',
      },
      {
        name: 'mcpServers',
        label: 'Разрешённые MCP-серверы',
        type: 'multi',
        value: v.mcpServers,
        options: data.mcpServers,
        hint: 'Сервер может предоставлять запись. При сохранении выполняются initialize и tools/list; разрешаются найденные инструменты.',
      },
      {
        name: 'deniedTools',
        label: 'Дополнительные запреты инструментов, по одному на строку',
        type: 'textarea',
        rows: 3,
        value: v.deniedTools.join('\n'),
        hint: 'Имена Nessy либо mcp__server / mcp__server__tool.',
      },
      {
        name: 'approvalMode',
        label: 'Подтверждения действий',
        type: 'select',
        value: v.approvalMode,
        options: [
          ['default', 'Запрашивать подтверждение'],
          ['plan', 'Планирование'],
          ['bubble', 'Запрос родительской сессии'],
          ['inherit', 'Правила родительской сессии'],
          ['auto-edit', 'Автоматическое редактирование'],
        ],
      },
      {
        name: 'model',
        label: 'Модель',
        value: v.model,
        required: true,
        max: 200,
        hint: 'inherit — текущая, fast — быстрая, либо ID настроенной модели.',
      },
      {
        name: 'maxTurns',
        label: 'Максимум шагов · 1–200',
        type: 'number',
        value: v.maxTurns,
        required: true,
      },
      {
        name: 'maxMinutes',
        label: 'Лимит времени · 1–60 минут',
        type: 'number',
        value: v.maxMinutes,
        required: true,
      },
      {
        name: 'color',
        label: 'Цвет в Nessy',
        type: 'select',
        value: v.color,
        options: [
          ['blue', 'Синий'],
          ['green', 'Зелёный'],
          ['red', 'Красный'],
          ['yellow', 'Жёлтый'],
          ['purple', 'Фиолетовый'],
          ['orange', 'Оранжевый'],
          ['pink', 'Розовый'],
          ['cyan', 'Бирюзовый'],
        ],
      },
    ],
    async (fields: any) => {
      for (const name of fields.mcpServers) {
        const check = await call('mcpProbe', { name });
        if (check.status !== 'ready')
          throw Error('MCP ' + name + ' не прошёл проверку: ' + (check.error || 'нет ответа'));
      }
      return call('agentDefinitionSave', {
        ...fields,
        deniedTools: lines(fields.deniedTools),
        originalName: existing ? d.name : undefined,
        expectedUpdatedAt: existing ? d.updatedAt : undefined,
      });
    },
    {
      after: () => app.refresh(),
      submit: 'Сохранить в Nessy',
      hint:
        existing && d.status === 'conflict'
          ? 'Файл изменён вне Companion. Создайте отдельную копию роли, чтобы сохранить внешние изменения.'
          : 'Настройки сохраняются в профиле Nessy Companion. После сохранения перезапустите Nessy. Создание роли не запускает модель.',
    },
  );
}
