import { useRef, useState } from 'react';
import {
  Action,
  Panel,
  Empty,
  Load,
  Status,
  Json,
  useLoad,
  useApp,
  call,
  api,
  date,
  short,
  type Row,
} from '../runtime';
import { Button } from '../components/primitives';
import { profileEditor } from '../editors';
export function SkillsPage() {
  const app = useApp(),
    state = useLoad(() => call('skills'));
  const [query, setQuery] = useState(''),
    [kind, setKind] = useState('Все'),
    [page, setPage] = useState(0);
  const compare = () => app.modal('Сверить навыки', <SkillCompare />);
  return (
    <Load state={state}>
      {(rows) => {
        const found = rows.filter(
          (s: Row) =>
            (kind === 'Все' || s.roles.includes(kind)) &&
            (s.name + ' ' + s.descriptionRu + ' ' + s.description + ' ' + s.package)
              .toLowerCase()
              .includes(query.toLowerCase()),
        );
        const start = Math.min(page, Math.max(0, Math.ceil(found.length / 30) - 1)) * 30;
        return (
          <>
            <p>
              {rows.length} определений в профиле Nessy · автовыбор у{' '}
              {rows.filter((s: Row) => s.automatic).length}
            </p>
            <div className="toolbar">
              <Button
                id="add-single-skill"
                className="primary"
                onClick={() =>
                  app.modal(
                    'Добавить один навык',
                    <>
                      <p>Для навыков со скриптами и шаблонами выбирайте всю папку.</p>
                      <div className="skill-import-options">
                        {['folder', 'file'].map((kind) => (
                          <Action
                            id={'import-skill-' + kind}
                            key={kind}
                            onClick={async () => {
                              const r = await api.importSkill(kind);
                              if (r) {
                                app.close();
                                app.refresh();
                              }
                            }}
                          >
                            {kind === 'folder'
                              ? 'Из папки с SKILL.md и ресурсами'
                              : 'Из отдельного файла SKILL.md'}
                          </Action>
                        ))}
                        <Button id="import-skill-bundled" onClick={compare}>
                          Выбрать из каталога Companion
                        </Button>
                      </div>
                    </>,
                  )
                }
              >
                Добавить навык
              </Button>
              <Button id="compare-skills" onClick={compare}>
                Сверить навыки
              </Button>
              <input
                className="grow"
                id="skill-query"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
                placeholder="Название, назначение или пакет"
              />
              <select
                id="skill-kind"
                aria-label="Категория навыков"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setPage(0);
                }}
              >
                {['Все', 'Общие', 'QA', 'SA', 'Dev'].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </div>
            <div className="role-tabs" id="role-tabs">
              {['Все', 'Общие', 'QA', 'SA', 'Dev'].map((k) => (
                <Button
                  key={k}
                  className={kind === k ? 'selected' : ''}
                  onClick={() => {
                    setKind(k);
                    setPage(0);
                  }}
                >
                  {k}
                  <small>
                    {k === 'Все'
                      ? rows.length
                      : rows.filter((s: Row) => s.roles.includes(k)).length}
                  </small>
                </Button>
              ))}
            </div>
            <div className="cards" id="skill-cards">
              {found.slice(start, start + 30).map((s: Row) => (
                <article className="skill-card" key={s.id}>
                  <span className="tag">
                    {s.enabled === false ? 'Выключен' : s.automatic ? 'Автовыбор' : 'По запросу'}
                  </span>
                  <h3>{s.name}</h3>
                  <span className="source">
                    {s.package} · {s.roles.join(', ')}
                  </span>
                  <p>{short(s.descriptionRu, 260)}</p>
                  <Action
                    data-skill={s.id}
                    onClick={async () => {
                      const d = await call('skill', { id: s.id });
                      app.modal(
                        d.name,
                        <>
                          {[
                            ['Назначение', d.descriptionRu],
                            ['Когда применять', d.when],
                            ['Порядок работы', d.how],
                            ['Зависимости', d.dependencies],
                            ['Пример запроса', d.example],
                          ].map(([t, v]) => (
                            <section className="detail-section" key={t}>
                              <h3>{t}</h3>
                              <p>{v}</p>
                            </section>
                          ))}
                          <details>
                            <summary>Исходная инструкция</summary>
                            <pre>{d.content}</pre>
                          </details>
                        </>,
                      );
                    }}
                  >
                    Открыть инструкцию
                  </Action>
                </article>
              ))}
            </div>
            <div className="pager">
              <Button disabled={!start} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                Назад
              </Button>
              <span>{found.length} определений</span>
              <Button disabled={start + 30 >= found.length} onClick={() => setPage((p) => p + 1)}>
                Далее
              </Button>
            </div>
          </>
        );
      }}
    </Load>
  );
}
function SkillCompare() {
  const app = useApp(),
    state = useLoad(() => call('skillCompare'));
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('changes');
  return (
    <Load state={state}>
      {(r) => (
        <>
          <p>
            Сравнение всех файлов каталога приложения с профилем Nessy. Изменения не заменяются
            автоматически.
          </p>
          <div className="skill-compare-summary">
            {[
              ['same', 'Совпадают'],
              ['missing', 'Не установлены'],
              ['different', 'Отличаются'],
              ['custom', 'Только в Nessy'],
            ].map(([id, t]) => (
              <span className="tag" key={id}>
                {t}: {r.entries.filter((e: Row) => e.status === id).length}
              </span>
            ))}
          </div>
          <div className="toolbar">
            <input
              id="compare-skill-query"
              placeholder="Название или пакет"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              id="compare-skill-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              {[
                ['changes', 'Отсутствуют или отличаются'],
                ['all', 'Все навыки'],
                ['missing', 'Не установлены'],
                ['different', 'Отличаются'],
                ['custom', 'Только в Nessy'],
              ].map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div id="skill-comparison">
            {r.entries
              .filter(
                (e: Row) =>
                  (e.name + ' ' + e.package).toLowerCase().includes(query.toLowerCase()) &&
                  (filter === 'all' ||
                    e.status === filter ||
                    (filter === 'changes' && ['missing', 'different'].includes(e.status))),
              )
              .map((e: Row) => (
                <div className="skill-compare-row" key={e.id}>
                  <div>
                    <h3>{e.name}</h3>
                    <p>
                      {e.package} ·{' '}
                      {
                        (
                          {
                            same: 'Совпадает',
                            missing: 'Не установлен',
                            different: 'Файлы отличаются',
                            custom: 'Пользовательский навык',
                          } as Row
                        )[e.status]
                      }
                    </p>
                  </div>
                  {['missing', 'different'].includes(e.status) ? (
                    <Action
                      data-install-single={e.id}
                      onClick={async () => {
                        if (
                          e.status === 'different' &&
                          !confirm('Заменить файлы навыка с резервной копией текущей версии?')
                        )
                          return;
                        await call('skillInstall', {
                          id: e.id,
                          replace: e.status === 'different',
                          expectedHash: e.installedHash,
                        });
                        app.refresh();
                      }}
                    >
                      {e.status === 'missing' ? 'Установить навык' : 'Обновить с резервной копией'}
                    </Action>
                  ) : (
                    <span className="tag">Установлен</span>
                  )}
                </div>
              ))}
          </div>
        </>
      )}
    </Load>
  );
}
export function InstalledTools() {
  const app = useApp(),
    state = useLoad(async () => ({
      rows: await call('mcp'),
      plugins: await call('plugins'),
      install: await call('installationStatus'),
      inventory: await call('inventory'),
    }));
  const [query, setQuery] = useState('');
  return (
    <Load state={state}>
      {({ rows, plugins, install, inventory }) => (
        <>
          <Panel title="Ваши инструменты — в Nessy">
            <p>
              Навыки, роли субагентов и MCP устанавливаются одним действием. Модели, авторизация и
              разрешения сохраняются.
            </p>
            <div className="toolbar">
              <Action
                id="install-managed"
                className="primary"
                onClick={async () => {
                  const r = await call('installExtension');
                  app.refresh();
                  app.detail('Расширение установлено', r);
                }}
              >
                Установить в Nessy Companion
              </Action>
              <Action
                id="install-existing"
                onClick={async () => {
                  const profile = await api.chooseFolder();
                  if (profile) {
                    const r = await call('installExtension', { profile });
                    app.refresh();
                    app.detail('Расширение установлено', r);
                  }
                }}
              >
                Установить в другой профиль Nessy…
              </Action>
            </div>
            <p className="source">
              {install.activeProfile || install.managedProfile} · установок {install.profiles.length}. Перезапустите Nessy
              после изменений.
            </p>
          </Panel>
          <input
            id="inventory-query"
            className="oc-full"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Найти MCP или плагин"
          />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Сервер</th>
                  <th>Транспорт</th>
                  <th>Команда / адрес</th>
                  <th>Включён</th>
                  <th>Проверка</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((r: Row) => r.name.toLowerCase().includes(query.toLowerCase()))
                  .map((r: Row) => {
                    const s = inventory.servers.find((s: Row) => s.name === r.name) || {};
                    return (
                      <tr key={r.name}>
                        <td>
                          {r.name}
                          <p className="source">
                            {s.description}
                            <br />
                            {s.source}
                          </p>
                        </td>
                        <td>{r.transport}</td>
                        <td className="source">
                          {r.config.command || r.config.httpUrl || r.config.url}
                          {r.commandAvailable === false && <p>Исполняемый файл не найден</p>}
                          <Button data-config={r.name} onClick={() => app.detail(r.name, r)}>
                            Конфигурация
                          </Button>
                        </td>
                        <td>
                          <input
                            type="checkbox"
                            data-toggle={r.name}
                            aria-label={'Включить ' + r.name}
                            checked={r.enabled}
                            onChange={(e) => {
                              const enabled = e.target.checked;
                              void app.run(async () => {
                                await call('mcpToggle', { name: r.name, enabled });
                                app.refresh();
                              });
                            }}
                          />
                        </td>
                        <td>
                          <Status value={s.status || 'unverified'} />
                          <details data-readiness>
                            <summary>Диагностика и следующий шаг</summary>
                            <ol>
                              {(s.readiness?.steps || []).map((x: Row, i: number) => (
                                <li key={i}>
                                  {x.title}:{' '}
                                  {(
                                    {
                                      passed: 'проверено',
                                      blocked: 'недоступно',
                                      failed: 'ошибка',
                                      unchecked: 'не проверено',
                                      'not-required': 'не требуется',
                                    } as Row
                                  )[x.status] || x.status}
                                </li>
                              ))}
                            </ol>
                            <p>{s.readiness?.hint}</p>
                            <p>{s.check?.error}</p>
                            <p>{date(s.check?.at)}</p>
                          </details>
                          <div className="table-actions">
                            <Action
                              data-probe={r.name}
                              disabled={!r.enabled}
                              onClick={async () => {
                                await call('mcpProbe', { name: r.name });
                                app.refresh();
                              }}
                            >
                              Проверить MCP
                            </Action>
                            <Action
                              data-resources={r.name}
                              disabled={!r.enabled}
                              onClick={async () => {
                                const result = await call('mcpResources', { name: r.name });
                                app.modal(
                                  'Проверка ресурса · ' + r.name,
                                  <>
                                    <p>
                                      Проверяется чтение одного ресурса. Прикладные инструменты MCP
                                      не вызываются.
                                    </p>
                                    <p>{result.error || result.resourceError}</p>
                                    {result.resourcesSupported === false && (
                                      <p>Сервер не объявляет MCP resources.</p>
                                    )}
                                    {(result.resources || []).map((x: Row) => (
                                      <div key={x.id}>
                                        <p>
                                          {x.name}
                                          <br />
                                          {x.uri}
                                        </p>
                                        <Action
                                          data-read-resource={x.id}
                                          onClick={async () => {
                                            const response = await call('mcpResourceRead', {
                                                name: r.name,
                                                resourceId: x.id,
                                                expectedFingerprint: result.fingerprint,
                                              }),
                                              c = response.resourceCheck;
                                            app.detail(
                                              'Результат чтения ресурса',
                                              c?.status === 'ready'
                                                ? `Выбранный ресурс прочитан: ${c.bytes} байт. Содержимое не сохранялось. Это не подтверждает доступ к другим ресурсам.`
                                                : c?.error ||
                                                    response.error ||
                                                    response.resourceError ||
                                                    'Чтение не подтверждено.',
                                            );
                                          }}
                                        >
                                          Проверить чтение
                                        </Action>
                                      </div>
                                    ))}
                                  </>,
                                );
                              }}
                            >
                              Ресурс проекта
                            </Action>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <h2>Расширения Nessy</h2>
          <div className="cards">
            {plugins
              .filter((p: Row) => p.name.toLowerCase().includes(query.toLowerCase()))
              .map((p: Row) => {
                const info = inventory.plugins.find((x: Row) => x.name === p.name);
                return (
                  <article className="skill-card" key={p.name}>
                    <h3>{p.name}</h3>
                    <p>
                      Версия {p.version} · навыков {p.skills} · агентов {p.agents}
                    </p>
                    <p>{info?.description}</p>
                    <p className="source">
                      {typeof info?.source === 'string'
                        ? info.source
                        : JSON.stringify(info?.source)}
                    </p>
                  </article>
                );
              })}
          </div>
        </>
      )}
    </Load>
  );
}
export function SystemsPage() {
  const app = useApp(),
    state = useLoad(() => call('taskCatalog'));
  return (
    <Load state={state}>
      {(d) => (
        <>
          <Panel title="Инструменты по рабочим системам">
            <p>Готовые наборы навыков и MCP.</p>
          </Panel>
          <div className="system-grid">
            {[...d.packages]
              .sort((a, b) => Number(!!a.pending) - Number(!!b.pending))
              .map((p: Row) => (
                <article className="system-card" key={p.id}>
                  <h3>{p.name}</h3>
                  <span className="tag">
                    {p.pending ? 'Требуется настройка' : 'Набор инструментов'}
                  </span>
                  <p className="system-description">{p.description}</p>
                  <div className="system-counts">
                    <span>{p.skills.length} навыков</span>
                    <span>{p.servers.length} MCP</span>
                  </div>
                  <details>
                    <summary>Состав и доступность</summary>
                    {p.skills.map((s: Row) => (
                      <p key={s.id || s.name}>
                        {s.name} · {s.enabled ? 'включён' : 'выключен'}
                      </p>
                    ))}
                    {p.servers.map((s: Row) => (
                      <p key={s.name}>
                        {s.name} <Status value={s.status} />
                      </p>
                    ))}
                    <p>{p.dependency}</p>
                    <p>Нет навыков: {p.missingSkills.join(', ') || '—'}</p>
                    <p>Нет MCP: {p.missingServers.join(', ') || '—'}</p>
                  </details>
                  <div className="card-actions">
                    <Button
                      data-task-example={p.id}
                      onClick={() =>
                        app.modal('Подбор для задачи', <TaskPicker initial={p.example} />)
                      }
                    >
                      Подготовить задачу
                    </Button>
                    <Button
                      data-package-preview={p.id}
                      onClick={() => app.modal('Установка пакета', <PackagePreview id={p.id} />)}
                    >
                      Проверить установку
                    </Button>
                  </div>
                </article>
              ))}
          </div>
        </>
      )}
    </Load>
  );
}
function PackagePreview({ id }: { id: string }) {
  const app = useApp(),
    state = useLoad(async () => ({
      plan: await call('systemPackagePreview', { id }),
      history: await call('systemPackageHistory'),
    }));
  return (
    <Load state={state}>
      {({ plan: p, history }) => (
        <>
          <p>{p.notice}</p>
          <h3>{p.name}</h3>
          <p>
            Установить навыки:{' '}
            {p.changes.install.map((s: Row) => s.name).join(', ') || 'не требуется'}
          </p>
          <p>Включить навыки: {p.changes.enableSkills.join(', ') || 'не требуется'}</p>
          <p>Включить MCP: {p.changes.enableMcp.join(', ') || 'не требуется'}</p>
          <p>Сохранить отличающиеся инструкции: {p.unchanged.join(', ') || 'нет'}</p>
          <p>Отдельная настройка MCP: {p.missingServers.join(', ') || 'нет'}</p>
          <p>Недоступны: {p.unavailable.join(', ') || 'нет'}</p>
          <p>Выключены расширения: {p.disabledExtensions.join(', ') || 'нет'}</p>
          <Action
            id="apply-system-package"
            disabled={!p.canApply}
            className="primary"
            onClick={async () => {
              const r = await call('systemPackageApply', { id, expectedHash: p.expectedHash });
              app.refresh();
              app.detail('Компоненты пакета установлены', r);
            }}
          >
            Применить эти изменения
          </Action>
          <h3>Установки пакета</h3>
          {history
            .filter((e: Row) => e.packageId === id)
            .map((e: Row) => (
              <div className="item" key={e.id}>
                {date(e.at)} · {e.status}
                {e.status === 'installed' && (
                  <Button
                    data-package-rollback={e.id}
                    onClick={() =>
                      app.edit(
                        'Откатить установку',
                        [],
                        () => call('systemPackageRollback', { id: e.id }),
                        {
                          submit: 'Подтвердить откат этой установки',
                          hint: 'Откат уберёт только добавленные этой установкой навыки и восстановит переключатели. Ручные изменения защищены.',
                        },
                      )
                    }
                  >
                    Откатить установку
                  </Button>
                )}
                {e.status === 'needs-recovery' && (
                  <Action
                    data-package-recovery={e.id}
                    onClick={async () => {
                      const r = await call('systemPackageRecoveryPreview', { id: e.id });
                      app.modal(
                        'Восстановление после прерывания',
                        <>
                          <Json value={r} />
                          <Action
                            id="recover-system-package"
                            disabled={!r.canRecover}
                            onClick={async () => {
                              await call('systemPackageRecover', {
                                id: r.id,
                                expectedHash: r.expectedHash,
                              });
                              app.close();
                              app.refresh();
                            }}
                          >
                            Подтвердить восстановление
                          </Action>
                        </>,
                      );
                    }}
                  >
                    Проверить восстановление
                  </Action>
                )}
              </div>
            ))}
        </>
      )}
    </Load>
  );
}
export function TaskPicker({ initial = '' }: { initial?: string }) {
  const app = useApp(),
    state = useLoad(() => call('taskCatalog'));
  const [prompt, setPrompt] = useState(initial),
    [manual, setManual] = useState(false),
    [skills, setSkills] = useState<string[]>([]),
    [servers, setServers] = useState<string[]>([]),
    [launched, setLaunched] = useState(false),
    [preview, setPreview] = useState<any>(null),
    [payload, setPayload] = useState<any>(null);
  const prepared = useRef<HTMLTextAreaElement>(null);
  return (
    <Load state={state}>
      {(data) => (
        <>
          <Panel title="Выберите инструменты для задачи">
            <form
              id="task-planner"
              onSubmit={(e) => {
                e.preventDefault();
                void app.run(async () => {
                  await api.runScenario({
                    assistant: true,
                    builder: 'tools',
                    description: prompt.trim(),
                  });
                  setLaunched(true);
                });
              }}
            >
              <label>
                Что вы хотите сделать?
                <textarea
                  id="task-prompt"
                  value={prompt}
                  required
                  maxLength={12000}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </label>
              <Button type="submit" className="primary">
                Подобрать с Nessy ↗
              </Button>
            </form>
            {launched && (
              <p role="status">
                Запрос открыт в Nessy. Она уточнит задачу и предложит набор инструментов.
              </p>
            )}
            <details className="utility-drawer">
              <summary>Ручной выбор и локальный предпросмотр</summary>
              <form
                id="task-manual-planner"
                onSubmit={(e) => {
                  e.preventDefault();
                  void app.run(async () => {
                    const input = {
                      prompt,
                      ...(manual ? { skillIds: skills } : {}),
                      mcpNames: servers,
                    };
                    const r = await call('taskPreview', input);
                    setPreview(r);
                    setPayload({ ...input, skillIds: r.skills.map((s: Row) => s.id) });
                    if (!manual) setSkills(r.skills.map((s: Row) => s.id));
                  });
                }}
              >
                <label>
                  <input
                    type="checkbox"
                    id="task-manual"
                    checked={manual}
                    onChange={(e) => setManual(e.target.checked)}
                  />
                  Выбрать навыки вручную
                </label>
                <label>
                  Навыки
                  <select
                    id="task-skills"
                    multiple
                    size={8}
                    disabled={!manual}
                    value={skills}
                    onChange={(e) => setSkills([...e.target.selectedOptions].map((o) => o.value))}
                  >
                    {data.skills
                      .filter((s: Row) => s.enabled)
                      .map((s: Row) => (
                        <option value={s.id} key={s.id}>
                          {s.name} — {short(s.descriptionRu || s.description, 80)}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  MCP
                  <select
                    id="task-mcp"
                    multiple
                    size={5}
                    value={servers}
                    onChange={(e) => setServers([...e.target.selectedOptions].map((o) => o.value))}
                  >
                    {data.servers
                      .filter((s: Row) => s.enabled)
                      .map((s: Row) => (
                        <option value={s.name} key={s.name}>
                          {s.name} · {s.status}
                        </option>
                      ))}
                  </select>
                </label>
                <Button type="submit">Проверить вручную</Button>
              </form>
            </details>
          </Panel>
          {preview && (
            <Panel title="Предпросмотр набора">
              {preview.skills.map((s: Row) => (
                <p key={s.id}>
                  <strong>{s.name}</strong>
                  <br />
                  {s.description}
                  <br />
                  {s.reason}
                </p>
              ))}
              <p>MCP: {preview.servers.map((s: Row) => s.name).join(', ') || 'Не выбраны'}</p>
              <textarea
                id="task-prepared"
                ref={prepared}
                rows={10}
                readOnly
                value={preview.preparedPrompt}
              />
              <div className="toolbar">
                <Action
                  id="task-run"
                  onClick={async () => {
                    const r = await api.runTask(payload);
                    if (r.opened)
                      app.detail(
                        'Набор передан Nessy',
                        'Открыт штатный CLI в режиме plan. Настройки профиля не менялись.',
                      );
                  }}
                >
                  Открыть в Nessy
                </Action>
                <Button
                  id="task-select"
                  onClick={() => {
                    prepared.current?.focus();
                    prepared.current?.select();
                  }}
                >
                  Выделить запрос
                </Button>
              </div>
            </Panel>
          )}
        </>
      )}
    </Load>
  );
}
export function ProfilesPage() {
  const app = useApp(),
    state = useLoad(() => call('toolProfiles'));
  return (
    <Load state={state}>
      {(data) => (
        <>
          <Panel
            title="Рабочие наборы инструментов"
            actions={
              <Button id="new-tool-profile" onClick={() => profileEditor(app, data)}>
                Создать профиль
              </Button>
            }
          >
            <p>
              Активный профиль:{' '}
              {data.profiles.find((p: Row) => p.id === data.active?.id)?.name || 'Не выбран'}
            </p>
          </Panel>
          <div className="cards">
            {data.profiles.map((p: Row) => (
              <article className="skill-card" key={p.id}>
                <h3>{p.name}</h3>
                <p>
                  {p.skillNames.length} навыков · {p.mcpNames.length} MCP · память{' '}
                  {p.memory ? 'включена' : 'приостановлена'}
                </p>
                <div className="card-actions">
                  <Button data-profile-edit={p.id} onClick={() => profileEditor(app, data, p)}>
                    {p.preset ? 'Создать на основе' : 'Изменить'}
                  </Button>
                  <Action
                    data-profile-preview={p.id}
                    onClick={async () => {
                      const c = await call('toolProfilePreview', { id: p.id });
                      app.modal(
                        'Применить профиль «' + c.profile.name + '»',
                        <>
                          <p>
                            Модели, авторизация и разрешения сохраняются. Настройки копируются в
                            резервный файл.
                          </p>
                          <h3>Навыки</h3>
                          {c.skills.map((x: Row) => (
                            <p key={x.name}>
                              {x.enabled ? '＋' : '−'} {x.name}
                            </p>
                          ))}
                          <h3>MCP</h3>
                          {c.mcp.map((x: Row) => (
                            <p key={x.name}>
                              {x.enabled ? 'Включить' : 'Выключить'} {x.name}
                            </p>
                          ))}
                          <p>Сбор знаний: {c.memory ? 'включить' : 'приостановить'}</p>
                          <Action
                            id="apply-tool-profile"
                            className="primary"
                            onClick={async () => {
                              const r = await call('toolProfileApply', {
                                id: c.profile.id,
                                expectedHash: c.expectedHash,
                              });
                              app.refresh();
                              app.detail(
                                'Профиль применён',
                                'Перезапустите Nessy. Резервная копия: ' + r.backup,
                              );
                            }}
                          >
                            Применить эти изменения
                          </Action>
                        </>,
                      );
                    }}
                  >
                    Проверить изменения
                  </Action>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </Load>
  );
}
export function DiagnosticsPage() {
  const app = useApp(),
    state = useLoad(() => call('diagnostics'));
  return (
    <Load state={state}>
      {(d) => (
        <>
          <p className="source">Обновлено: {date(d.checkedAt)}</p>
          {d.migrationWarnings?.map((s: string) => (
            <p className="warning" key={s}>
              {s}
            </p>
          ))}
          <div className="cards">
            {d.services.map((s: Row) => (
              <article className="skill-card" key={s.id || s.name}>
                <h3>{s.name}</h3>
                <Status value={s.status} />
                <p>{s.error}</p>
                <p className="source">
                  {s.lastScanAt && date(s.lastScanAt)} {s.captured}
                </p>
              </article>
            ))}
          </div>
          <Panel title="Поиск и индексы">
            {d.indexes.map((i: Row) => (
              <div className="item" key={i.collection || i.id}>
                <strong>{i.collection || i.id}</strong>
                <p>
                  {i.chunks} фрагментов · {date(i.updatedAt)} · изменились {i.changedSources || 0} ·
                  отсутствуют {i.missingSources || 0}
                </p>
              </div>
            ))}
            <p>
              Последний поиск: {date(d.lastSearch?.at)} {d.lastSearch?.error}
            </p>
            <Button id="diagnostic-rag" onClick={() => app.go('rag')}>
              Открыть RAG
            </Button>
          </Panel>
          <Panel title="MCP">
            {d.servers.map((s: Row) => (
              <div className="item" key={s.name}>
                <strong>{s.name}</strong> <Status value={s.status} />
                <p>
                  {s.error} · {date(s.checkedAt)}
                </p>
              </div>
            ))}
          </Panel>
        </>
      )}
    </Load>
  );
}
