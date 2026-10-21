import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildUiSkills } from './build-ui-skills.mjs';
import { buildDesktopCatalog } from './desktop-catalog.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const shared = join(root, 'shared');
const skillRoot = join(shared, 'skills');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const catalog = read(join(shared, 'skills-catalog.json'));
const lock = read(join(shared, 'skills.lock.json'));
const entries = new Map(catalog.entries.map((entry) => [entry.name, entry]));
const expected = new Set([...lock.skills.map((skill) => skill.name), 'odysseus-workspace']);
if (entries.size !== expected.size || [...expected].some((name) => !entries.has(name))) {
  throw new Error('Catalog must cover every active skill exactly once');
}
const walk = (path) =>
  readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unsupported symlink: ${child}`);
    return entry.isDirectory() ? walk(child) : [child];
  });
const marker = '<!-- odysseus-invocation-policy -->';
const endMarker = '<!-- /odysseus-invocation-policy -->';
for (const entry of catalog.entries) {
  if (!/[А-Яа-яЁё]/u.test(entry.description) || entry.description.length > 1024) {
    throw new Error(`Invalid Russian description: ${entry.name}`);
  }
  const directory = join(skillRoot, entry.name);
  // Keep untouched upstream examples usable after consolidation: old tool/
  // skill names must be resolved before asking the host to load a skill.
  const referenceText = walk(directory)
    .filter((path) => path.endsWith('.md') && !path.endsWith('/SKILL.md'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  const path = join(directory, 'SKILL.md');
  const text = readFileSync(path, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`Invalid skill: ${path}`);
  // Imported frontmatter uses JSON values (a YAML subset). The service skill
  // predates that normalization and has only name/description.
  const header =
    entry.name === 'odysseus-workspace'
      ? { name: entry.name }
      : Object.fromEntries(
          match[1].split('\n').map((line) => {
            const field = line.match(/^([a-z][a-z0-9_-]*): (.+)$/);
            if (!field) throw new Error(`Invalid frontmatter: ${entry.name}: ${line}`);
            return [field[1], JSON.parse(field[2])];
          }),
        );
  header.name = entry.name;
  header.description = entry.description;
  header['disable-model-invocation'] = !entry.automatic;
  header['user-invocable'] = true;
  header.when_to_use = entry.when;
  if (header.metadata?.['short-description'])
    header.metadata['short-description'] = entry.description;
  let body = match[2];
  if (body.includes(marker)) {
    const start = body.indexOf(marker),
      end = body.indexOf(endMarker, start);
    if (end < start) throw new Error(`Unclosed policy: ${entry.name}`);
    body = body.slice(0, start) + body.slice(end + endMarker.length).replace(/^\n+/, '');
  }
  const oldNames = Object.entries(lock.consolidation.aliases).filter(
    ([old, canonical]) =>
      canonical !== entry.name && (referenceText.includes(old) || body.includes(old)),
  );
  const routes = oldNames.length
    ? '\n\nСсылки на прежние имена в исходных руководствах разрешай до загрузки навыка: ' +
      oldNames.map(([old, canonical]) => `«${old}» → «${canonical}», режим «${old}»`).join('; ') +
      '. Старое имя не является отдельной командой.'
    : '';
  const policy = `${marker}\n## Выбор и запуск\n\n${
    entry.automatic
      ? 'Навык можно выбирать автоматически, когда текущая задача соответствует описанию. Загружай только нужный режим и относящиеся к нему ресурсы.'
      : 'Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.'
  }\n\nАвтовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.${routes}\n${endMarker}\n\n`;
  writeFileSync(
    path,
    '---\n' +
      Object.entries(header)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join('\n') +
      '\n---\n\n' +
      policy +
      body.trimStart(),
  );
  const uiPath = join(directory, 'agents', 'openai.yaml');
  // UI metadata is optional. Preserve all existing tool dependencies and icons.
  // Don't manufacture extra UI files just to duplicate native frontmatter.
  if (walk(directory).some((path) => path.endsWith('/openai.yaml'))) {
    for (const yamlPath of walk(directory).filter((path) => path.endsWith('/openai.yaml'))) {
      const ui = read(yamlPath);
      ui.interface ??= {};
      ui.interface.display_name = entry.description.split(':')[0].slice(0, 95);
      ui.interface.short_description =
        entry.description.length <= 64 ? entry.description : entry.description.slice(0, 63) + '…';
      ui.interface.default_prompt = `Используй $${entry.name}. ${entry.example}`;
      ui.policy ??= {};
      ui.policy.allow_implicit_invocation = yamlPath === uiPath && entry.automatic;
      save(yamlPath, ui); // JSON is valid YAML and preserves nested settings.
    }
  }
  const pinned = lock.skills.find((skill) => skill.name === entry.name);
  if (pinned) {
    pinned.description = entry.description;
    pinned.automatic = entry.automatic;
    const originPath = join(directory, 'UPSTREAM.json');
    const origin = read(originPath);
    origin.adaptations ??= [];
    const adaptation =
      'Russian discovery metadata and task-scoped invocation policy; original descriptions retained in upstreamFrontmatter.';
    if (!origin.adaptations.includes(adaptation)) origin.adaptations.push(adaptation);
    save(originPath, origin);
    pinned.files = Object.fromEntries(
      walk(directory)
        .sort()
        .map((path) => [
          relative(directory, path),
          {
            sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
            executable: Boolean(statSync(path).mode & 0o111),
          },
        ]),
    );
  }
}
lock.catalogLanguage = 'ru';
lock.invocation = {
  automatic: catalog.entries.filter((entry) => entry.automatic).length,
  explicit: catalog.entries.filter((entry) => !entry.automatic).length,
};
save(join(shared, 'skills.lock.json'), lock);

const roleSelections = [
  {
    id: 'general',
    title: 'Общие полезные навыки',
    intro: 'Для повседневной работы независимо от роли.',
    skills: [
      ['clarify', 'Уточнить неоднозначную задачу и ожидаемый результат'],
      ['brainstorming', 'Обсудить идею и выбрать подход перед реализацией'],
      ['browser', 'Открыть сайт, собрать информацию или проверить сценарий'],
      ['research', 'Исследовать вопрос и сохранить выводы с источниками'],
      ['humanizer', 'Сделать русский или английский текст естественным'],
      ['doc-coauthoring', 'Совместно подготовить понятный документ'],
      ['pdf', 'Прочитать, собрать или обработать PDF'],
      ['docx', 'Создать или отредактировать Word-документ'],
      ['xlsx', 'Обработать таблицу, данные и формулы'],
      ['pptx', 'Подготовить или изменить презентацию'],
      ['mermaid', 'Объяснить процесс или связи с помощью диаграммы'],
      ['obsidian-markdown', 'Оформить заметки, ссылки и свойства Obsidian'],
      ['handoff', 'Передать контекст работы другому участнику'],
    ],
  },
  {
    id: 'qa',
    title: 'QA — тестирование и качество',
    intro: 'От анализа требований до автотестов и проверки релиза.',
    skills: [
      ['init-qa', 'Собрать QA-контекст нового проекта в NESSY.md'],
      ['three-amigo', 'Подготовить вопросы и сценарии к обсуждению задачи Jira'],
      ['pgsme-coverage-matrix', 'Построить матрицу покрытия, границ и классов эквивалентности'],
      ['generate-tests', 'Написать исполняемые тесты по требованиям'],
      ['validate-tests', 'Оценить качество существующих тестов'],
      ['webapp-testing', 'Проверить веб-сценарий через Playwright'],
      ['visual-qa', 'Проверить внешний вид, темы и размеры экрана'],
      ['systematic-debugging', 'Воспроизвести дефект и найти его причину'],
      ['allure-testops', 'Найти или зарезервировать Allure ID и связать тесты'],
      ['tperf-report-analyzer', 'Разобрать нагрузочный тест и узкие места'],
      ['dp-sage', 'Исследовать ошибки сервиса по журналам'],
      ['verification-before-completion', 'Подтвердить результат проверками перед завершением'],
    ],
  },
  {
    id: 'dev',
    title: 'DEV — разработка',
    intro: 'Проектирование, реализация, диагностика и ревью кода.',
    skills: [
      ['repo-analysis', 'Разобраться в структуре приложения и зависимостях'],
      ['codebase-design', 'Спроектировать границы и интерфейсы модулей'],
      ['writing-plans', 'Разложить реализацию на проверяемые шаги'],
      ['implement', 'Реализовать готовую спецификацию или набор задач'],
      ['test-driven-development', 'Разрабатывать через цикл тест — реализация — рефакторинг'],
      ['systematic-debugging', 'Найти причину ошибки или регрессии производительности'],
      ['safe-refactor', 'Упростить код с сохранением поведения'],
      ['ast-grep', 'Найти или преобразовать структурный шаблон кода'],
      ['omo-codex-lsp', 'Найти определения, ссылки и диагностику через LSP'],
      ['code-review', 'Проверить изменения относительно требований и стандартов'],
      ['sql-postgres-optimization', 'Оптимизировать запрос, индекс или миграцию PostgreSQL'],
      ['tech-docs', 'Обновить документацию сервиса по исходному коду'],
      ['git-master', 'Исследовать историю и выполнить нужную операцию Git'],
      ['mcp-builder', 'Разработать MCP-сервер для интеграции инструментов'],
    ],
  },
  {
    id: 'analysts',
    title: 'Аналитики — требования, процессы и данные',
    intro: 'Для системных, бизнес- и дата-аналитиков.',
    skills: [
      ['clarify', 'Уточнить бизнес-задачу, ограничения и ожидаемый результат'],
      ['domain-modeling', 'Согласовать термины и модель предметной области'],
      ['spec-create', 'Создать спецификацию из эпика через интервью'],
      ['spec-import', 'Перенести спецификацию из Confluence в документы проекта'],
      ['spec-review', 'Сверить сценарии, БД, API, ошибки и требования'],
      ['mermaid', 'Описать взаимодействия, состояния или модель данных диаграммой'],
      ['camunda-modeler-editor', 'Подготовить или изменить BPMN-процесс'],
      ['analytics-sql', 'Написать SQL для метрик, когорт и отчётов'],
      ['data-scientist', 'Очистить и исследовать CSV, JSON или Parquet'],
      ['xlsx', 'Рассчитать и оформить результаты в таблице'],
      ['search-all', 'Собрать связанный контекст из Jira, Confluence и GitLab'],
      ['wixie-cli', 'Найти или экспортировать исходные документы Confluence'],
      ['sage-metrics-analyst', 'Исследовать метрики сервиса и условия алертов'],
      ['whiteboard-roadmap-creator', 'Построить дорожную карту по датам и зависимостям'],
    ],
  },
];
const quickStart = [
  '## Быстрый выбор по роли',
  '',
  roleSelections.map((role) => `[${role.title}](#role-${role.id})`).join(' · '),
  '',
  'Начни с общих навыков и добавь подходящий инструмент из своей роли. Один навык может быть полезен нескольким ролям. Пометка «автовыбор» означает выбор по текущей задаче; «явно» — прямой запрос пользователя. Требования к приложениям и корпоративным подключениям указаны в подробной карточке по ссылке.',
  '',
];
for (const role of roleSelections) {
  quickStart.push(`<a id="role-${role.id}"></a>`, `### ${role.title}`, '', role.intro, '');
  for (const [name, purpose] of role.skills) {
    const entry = entries.get(name);
    if (!entry) throw new Error(`Unknown skill in role selection: ${name}`);
    quickStart.push(
      `- [${name}](#skill-${name}) — ${purpose}. **${entry.automatic ? 'Автовыбор' : 'Явно'}.`,
    );
  }
  quickStart.push('');
}

const text = [
  '# Справочник общих навыков Odysseus',
  '',
  ...quickStart,
  `В каталоге **${catalog.entries.length} самостоятельных навыка**: ${lock.skills.length} импортированных и один служебный. После анализа объединены ${lock.consolidation.mergedEntries} повторяющихся входов. Скрипты, шаблоны и альтернативные руководства сохранены внутри общего навыка.`,
  '',
  '## Как пользоваться',
  '',
  '- В Nessy CLI и Desktop открой один и тот же подключённый проект. После изменения каталога выполни `npm run sync` в корне Odysseus и обнови сессию приложения.',
  '- Автовыбор означает загрузку навыка моделью по содержанию уже поставленной задачи. Это не расписание, фоновое выполнение или гарантия срабатывания: выбор зависит от модели и доступных инструментов.',
  '- Для явного вызова укажи имя навыка в запросе или выбери его в интерфейсе приложения. Конкретный синтаксис slash-команд зависит от клиента.',
  '- В русских описаниях сохранены технические имена. Рабочие руководства и документация поставщиков местами остаются на исходном языке.',
  '- Флаги `disable-model-invocation` и `user-invocable` записаны в каждом SKILL.md; существующие `agents/openai.yaml` согласованы с ними.',
  '- Режимы публикации, сообщений, корпоративных изменений и специального общения требуют явного запроса. Подключения и учётные данные не появляются от установки навыка.',
  '- Для объединённого навыка выбирай один режим. Основные ресурсы остаются в его корне; дополнительные — в `variants/<прежнее-имя>/`. Локальные и корпоративные ограничения сохраняются по режимам.',
  '',
  `Автовыбор включён у **${lock.invocation.automatic}** навыков; **${lock.invocation.explicit}** требуют явного вызова.`,
  '',
  '## Навигация',
  '',
];
const categories = [...new Set(catalog.entries.map((entry) => entry.category))];
for (const category of categories) {
  const group = catalog.entries.filter((entry) => entry.category === category);
  text.push(`- [${group[0].categoryTitle}](#category-${category}) — ${group.length}`);
}
for (const category of categories) {
  const group = catalog.entries
    .filter((entry) => entry.category === category)
    .sort((a, b) => a.name.localeCompare(b.name));
  text.push('', `<a id="category-${category}"></a>`, `## ${group[0].categoryTitle}`, '');
  for (const entry of group) {
    const source = `../shared/skills/${entry.name}`;
    text.push(
      `<a id="skill-${entry.name}"></a>`,
      `### ${entry.name}`,
      '',
      entry.description,
      '',
      `- **Когда:** ${entry.when}`,
      `- **Как:** ${entry.how}`,
      `- **Запрос:** «${entry.example}»`,
      `- **Выбор:** ${entry.automatic ? 'автоматически по подходящей задаче или явно' : 'только по явному запросу'}.`,
      `- **Нужно:** ${entry.dependencies}`,
      `- **Инструкция:** [SKILL.md](${source}/SKILL.md).`,
    );
    if (entry.aliases.length)
      text.push(
        `- **Объединённые имена:** ${entry.aliases.map((name) => `\`${name}\``).join(', ')}. Используй имя «${entry.name}»; прежние имена — указатели в справочнике, отдельных команд для них нет.`,
      );
    if (entry.resources.length)
      text.push(
        `- **Ресурсы:** ${entry.resources.map((path) => `[${path}](${source}/${path})`).join(', ')}.`,
      );
    if (entry.packageDependencies?.length)
      text.push(`- **Неполный комплект:** ${JSON.stringify(entry.packageDependencies)}.`);
    text.push('');
  }
}
text.push('## Какие навыки объединены', '');
for (const group of lock.consolidation.groups)
  text.push(
    `- ${group.merged.map((name) => `\`${name}\``).join(', ')} → [${group.name}](#skill-${group.name}). ${group.reason}`,
  );
text.push(
  '',
  'Близкие по теме, но разные по результату процессы оставлены отдельными: общее PPTX и корпоративный шаблон; Manim CE и ManimGL; подготовка плана и его выполнение; общая работа с FFmpeg и монтажный сценарий; создание навыка и его поведенческое тестирование. Разные адаптеры n8n также сохранены: корпоративный CLI и MCP предъявляют разные требования к подключению.',
  '',
  '## Обслуживание каталога',
  '',
  '- `shared/skills-catalog.json` — русские описания, сценарии и режимы выбора.',
  '- `shared/skills-consolidation.json` — соответствие прежних имён общим навыкам.',
  '- `shared/skills.lock.json` и UPSTREAM.json — источники, сохранённые варианты и контрольные суммы.',
  '- `npm run catalog:build` — обновляет описания, политики выбора, справочник и контрольные суммы из каталога. После изменений запусти `npm test` и `npm run sync`.',
  '- Отчёт `shared/user-skills-import.json` описывает первоначальный импорт; имена в нём разрешаются через список объединений. Это история, а не список текущих самостоятельных команд.',
  '- Резервная копия до объединения: `' +
    lock.consolidation.backup +
    '/`. Её не нужно подключать как каталог навыков.',
  '',
);
writeFileSync(join(root, 'docs', 'skills-catalog-ru.md'), text.join('\n'));
buildDesktopCatalog(catalog, roleSelections, root);
console.log(
  `${catalog.entries.length} skills: ${lock.invocation.automatic} automatic, ${lock.invocation.explicit} explicit; handbook generated`,
);

// Keep the native role catalog aligned with shared skill discovery metadata.
buildUiSkills(root);
