import { useState } from 'react';
import {
  Action,
  Panel,
  Empty,
  Load,
  Status,
  useLoad,
  useApp,
  call,
  api,
  date,
  short,
  lines,
  nessyBuilder,
  type Row,
  type Field,
} from '../runtime';
import { Button, ScopeFields } from '../components/primitives';
import { Graph } from '../components/Graph';
import { memoryEditor, decisionEditor } from '../editors';
import { taskEditor, ChatView } from './PersonalPages';
export function ScopeBar({ actions }: { actions?: React.ReactNode }) {
  const a = useApp();
  return (
    <div className="oc-scope-bar">
      <ScopeFields
        catalogs={a.catalogs}
        collection={a.collection}
        project={a.project}
        onCollection={(c) => a.setScope(c, '')}
        onProject={(p) => a.setScope(a.collection, p)}
        actions={actions}
      />
    </div>
  );
}
export function KnowledgeGraph() {
  const app = useApp();
  const [filter, setFilter] = useState<Row>({
      mode: 'catalog',
      type: '',
      relation: '',
      from: '',
      focus: '',
      offset: 0,
      query: '',
    }),
    [node, setNode] = useState<Row | null>(null);
  const state = useLoad(
    async () => ({
      g: await call(filter.mode === 'catalog' ? 'graphView' : 'knowledgeExplore', {
        ...app.scope,
        ...filter,
        view: 'catalog',
      }),
      info: await call('knowledgeExplore', { ...app.scope, mode: 'all' }),
    }),
    [JSON.stringify(app.scope), JSON.stringify(filter)],
  );
  const change = (v: Row) => setFilter((f) => ({ ...f, offset: 0, ...v }));
  return (
    <>
      <Panel
        title="Исследуйте связи"
        actions={
          <Button
            className="primary"
            onClick={() =>
              nessyBuilder(
                app,
                'knowledge',
                undefined,
                'Помоги разобраться в связях выбранного проекта.',
                app.scope,
              )
            }
          >
            Помочь с графом · Nessy ↗
          </Button>
        }
      >
        <ScopeBar
          actions={
            <>
              <Action
                id="add-project"
                onClick={async () => {
                  const path = await api.chooseFolder();
                  if (path) {
                    await call('registerProject', { path });
                    app.refresh();
                  }
                }}
              >
                Добавить проект
              </Action>
              <Action
                id="refresh-graph"
                onClick={async () =>
                  app.detail(
                    'Обновление графа',
                    await call('refreshGraph', app.project ? { project: app.project } : {}),
                  )
                }
              >
                Обновить индекс графа
              </Action>
              <Button
                id="create-collection"
                onClick={() =>
                  app.edit(
                    'Новый каталог знаний',
                    [{ name: 'name', label: 'Название', required: true }],
                    async (v) => {
                      const r = await call('collectionEdit', { type: 'create', name: v.name });
                      app.setScope(r.createdId, '');
                    },
                  )
                }
              >
                Новый каталог
              </Button>
            </>
          }
        />
        <Button onClick={() => app.go('rag')}>Найти в документах ↗</Button>
      </Panel>
      <form
        className="toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          change({ query: new FormData(e.currentTarget).get('query') });
        }}
      >
        <input
          name="query"
          id="graph-query"
          className="grow"
          placeholder="Поиск узла по названию"
        />
        <Button id="graph-search" type="submit">
          Найти
        </Button>
        <Button
          id="graph-root"
          onClick={() => {
            setNode(null);
            change({ focus: '', query: '' });
          }}
        >
          К корню каталога
        </Button>
      </form>
      <Load state={state}>
        {({ g, info }) => (
          <>
            <p className="source">
              В выборке: {g.nodes.length} узлов · {g.links.length} связей.
              Ctrl + колесо — масштаб · фон — перемещение.
            </p>
            <Graph nodes={g.nodes || []} links={g.links || []} onSelect={setNode} />
            {node && (
              <Panel title={node.label}>
                <p className="answer">{node.description}</p>
                <p className="source">{node.source_file || node.id}</p>
                <div className="toolbar">
                  <Button
                    onClick={() =>
                      change({
                        focus: node.id,
                        mode: filter.mode === 'catalog' ? 'catalog' : 'neighbors',
                      })
                    }
                  >
                    {['project', 'folder'].includes(node.type)
                      ? 'Раскрыть папку'
                      : 'Показать связи'}
                  </Button>
                  {node.source_file && (
                    <Action
                      onClick={async () => {
                        const d = await call('document', {
                          nodeId: node.id,
                          path: node.source_file,
                        });
                        app.detail(d.path, d.content || 'Источник без текстового содержимого');
                      }}
                    >
                      Прочитать источник
                    </Action>
                  )}
                  {node.manual && (
                    <Action
                      onClick={async () => {
                        await call('graphEdit', { type: 'remove-manual', id: node.id });
                        setNode(null);
                        app.refresh();
                      }}
                    >
                      Удалить ручную запись
                    </Action>
                  )}
                </div>
              </Panel>
            )}
            <div className="pager">
              <Button
                disabled={!filter.offset}
                onClick={() => setFilter({ ...filter, offset: Math.max(0, filter.offset - 100) })}
              >
                Назад
              </Button>
              <span>
                {Math.min(filter.offset + 100, g.totalMatches || 0)} из {g.totalMatches || 0}
              </span>
              <Button
                disabled={filter.offset + 100 >= (g.totalMatches || 0)}
                onClick={() => setFilter({ ...filter, offset: filter.offset + 100 })}
              >
                Далее
              </Button>
            </div>
            <details className="utility-drawer">
              <summary>Добавить заметку или связь вручную</summary>
              <div className="toolbar">
                <Button
                  id="save-note"
                  onClick={() =>
                    app.edit(
                      'Добавить знание',
                      [
                        { name: 'title', label: 'Заголовок', required: true },
                        {
                          name: 'text',
                          label: 'Текст',
                          type: 'textarea',
                          required: true,
                          wide: true,
                        },
                      ],
                      (v) => call('save', { ...app.scope, ...v }),
                    )
                  }
                >
                  Добавить заметку
                </Button>
                <Button
                  id="add-link"
                  onClick={() =>
                    app.edit(
                      'Связь с основанием',
                      [
                        {
                          name: 'source',
                          label: 'Откуда',
                          type: 'select',
                          options: g.nodes.map((n: Row) => [n.id, n.label]),
                        },
                        {
                          name: 'target',
                          label: 'Куда',
                          type: 'select',
                          options: g.nodes.map((n: Row) => [n.id, n.label]),
                        },
                        { name: 'relation', label: 'Тип связи', required: true },
                        { name: 'evidence', label: 'Основание', required: true },
                      ],
                      (v) =>
                        call('graphEdit', { type: 'add-link', collection: app.collection, ...v }),
                    )
                  }
                >
                  Добавить связь
                </Button>
              </div>
            </details>
            <details className="utility-drawer graph-advanced">
              <summary>Дополнительные фильтры и режимы</summary>
              <form
                className="toolbar"
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = Object.fromEntries(new FormData(e.currentTarget));
                  change({
                    ...v,
                    mode: v.mode === 'catalog' ? 'all' : v.mode,
                    focus: v.mode === 'neighbors' ? node?.id || filter.focus : filter.focus,
                  });
                }}
              >
                <label>
                  Режим
                  <select
                    name="mode"
                    id="graph-mode"
                    value={filter.mode}
                    onChange={(e) =>
                      change({
                        mode: e.target.value,
                        focus: e.target.value === 'neighbors' ? node?.id || filter.focus : '',
                      })
                    }
                  >
                    {[
                      ['catalog', 'Каталог и папки'],
                      ['all', 'Все связи'],
                      ['projects', 'Проекты'],
                      ['documents', 'Документы'],
                      ['decisions', 'Решения'],
                      ['neighbors', 'Связи выбранного узла'],
                    ].map(([v, t]) => (
                      <option value={v} key={v}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Тип узла
                  <select name="type" defaultValue={filter.type}>
                    <option value="">Все типы</option>
                    {info.types.map((s: string) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Тип связи
                  <select name="relation" defaultValue={filter.relation}>
                    <option value="">Все связи</option>
                    {info.relations.map((s: string) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Создано с<input name="from" type="date" defaultValue={filter.from} />
                </label>
                <Button type="submit">Применить</Button>
              </form>
            </details>
          </>
        )}
      </Load>
    </>
  );
}
export function SourcesPage() {
  const app = useApp(),
    state = useLoad(() => call('sourceHealth', app.scope), [JSON.stringify(app.scope)]);
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState('all'),
    [page, setPage] = useState(0);
  return (
    <>
      <ScopeBar />
      <Load state={state}>
        {(data) => {
          const rows = data.sources
            .map((s: Row, index: number) => ({ ...s, index }))
            .filter(
              (s: Row) =>
                (s.title + ' ' + s.source).toLowerCase().includes(query.toLowerCase()) &&
                (status === 'all' || (status === 'review' ? s.needsReview : s.status === status)),
            );
          const start = Math.min(page, Math.max(0, Math.ceil(rows.length / 40) - 1)) * 40;
          return (
            <>
              <div className="source-filters">
                <input
                  id="source-query"
                  className="grow"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(0);
                  }}
                  placeholder="Название или путь документа"
                />
                <select
                  id="source-status"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setPage(0);
                  }}
                >
                  {[
                    ['all', 'Все источники'],
                    ['review', 'Нужна проверка'],
                    ['available', 'Доступны локально'],
                    ['missing', 'Удалённые файлы'],
                    ['unreadable', 'Нет доступа'],
                    ['external', 'Внешние'],
                  ].map(([v, t]) => (
                    <option value={v} key={v}>
                      {t}
                    </option>
                  ))}
                </select>
                <span id="source-count">{rows.length} источников</span>
              </div>
              <div className="table-wrap" id="source-table">
                <table className="sources-table">
                  <colgroup>
                    <col className="source-col" />
                    <col className="state-col" />
                    <col className="review-col" />
                    <col className="actions-col" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Источник</th>
                      <th>Состояние</th>
                      <th>Проверка</th>
                      <th>Действия</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(start, start + 40).map((s: Row) => (
                      <tr key={s.index}>
                        <td>
                          {s.title}
                          <p className="source source-path">{s.source}</p>
                        </td>
                        <td>
                          {
                            (
                              {
                                available: 'Доступен',
                                missing: 'Файл удалён',
                                unreadable: 'Нет доступа',
                                external: 'Внешний',
                              } as Row
                            )[s.status]
                          }
                          <p className="source">{s.modifiedAt && date(s.modifiedAt)}</p>
                        </td>
                        <td>
                          {s.needsReview ? 'Нужна проверка' : 'Проверен'}
                          <p>{s.review?.owner}</p>
                        </td>
                        <td>
                          <div className="table-actions">
                            <Button
                              data-review-source={s.index}
                              disabled={s.status !== 'available'}
                              onClick={() =>
                                app.edit(
                                  'Проверка источника',
                                  [
                                    {
                                      name: 'owner',
                                      label: 'Кто проверил',
                                      required: true,
                                      value: s.review?.owner,
                                      max: 200,
                                    },
                                    {
                                      name: 'note',
                                      label: 'Что проверено',
                                      type: 'textarea',
                                      value: s.review?.note,
                                      wide: true,
                                      max: 2000,
                                    },
                                  ],
                                  (v) =>
                                    call('sourceReview', {
                                      ...app.scope,
                                      ...v,
                                      source: s.source,
                                      expectedStamp: s.stamp,
                                    }),
                                  { hint: s.source },
                                )
                              }
                            >
                              Проверить
                            </Button>
                            <Action
                              data-exclude-source={s.index}
                              onClick={async () => {
                                await call('sourceExclusion', {
                                  action: 'add',
                                  source: s.source,
                                  nodeId: s.nodeId,
                                  ...app.scope,
                                });
                                app.refresh();
                              }}
                            >
                              Исключить
                            </Action>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pager">
                <Button
                  id="sources-prev"
                  disabled={!start}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Назад
                </Button>
                <span>
                  {rows.length ? start + 1 : 0}–{Math.min(start + 40, rows.length)} из {rows.length}
                </span>
                <Button
                  id="sources-next"
                  disabled={start + 40 >= rows.length}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Далее
                </Button>
              </div>
            </>
          );
        }}
      </Load>
    </>
  );
}
export function PassportsPage() {
  const app = useApp(),
    state = useLoad(() => call('projectPassports'));
  return (
    <Load state={state}>
      {(data) => (
        <>
          <Panel title="Контекст проекта для Nessy">
            <p>Паспорт передаётся перед запросом для соответствующей рабочей папки Nessy.</p>
          </Panel>
          <div className="cards">
            {data.projects.map((project: Row) => {
              const p = data.passports.find((x: Row) => x.project === project.id);
              return (
                <article className="skill-card" key={project.id}>
                  <h3>{project.name}</h3>
                  <p className="source">{project.path}</p>
                  <p>{p?.summary || 'Паспорт не заполнен'}</p>
                  <p>{p && `Версия ${p.revision} · ${p.enabled ? 'Включён' : 'Приостановлен'}`}</p>
                  <Button
                    data-passport={project.id}
                    onClick={() =>
                      app.edit(
                        'Паспорт проекта',
                        (
                          [
                            ['owner', 'Владелец знаний'],
                            ['summary', 'Назначение и границы проекта'],
                            ['businessRules', 'Бизнес-правила'],
                            ['architecture', 'Архитектура и сервисы'],
                            ['terms', 'Термины'],
                            ['sources', 'Источники — по одному на строке'],
                          ].map(([name, label]) => ({
                            name,
                            label,
                            type: name === 'owner' ? 'text' : 'textarea',
                            wide: true,
                            value: name === 'sources' ? p?.sources.join('\n') : p?.[name],
                            group: name === 'summary' ? undefined : 'Подробности проекта',
                          })) as Field[]
                        ).concat([
                          {
                            name: 'enabled',
                            label: 'Передавать паспорт в контекст',
                            type: 'checkbox',
                            value: p?.enabled ?? true,
                          },
                        ]),
                        (v) =>
                          call('projectPassportSave', {
                            ...v,
                            project: project.id,
                            sources: lines(v.sources),
                            expectedRevision: p?.revision || 0,
                          }),
                      )
                    }
                  >
                    {p ? 'Изменить паспорт' : 'Заполнить паспорт'}
                  </Button>
                </article>
              );
            })}
          </div>
        </>
      )}
    </Load>
  );
}
export function InboxPage({ initialSelected = [] }: { initialSelected?: string[] }) {
  const app = useApp(),
    [status, setStatus] = useState('pending'),
    [query, setQuery] = useState(''),
    [selected, setSelected] = useState<string[]>(initialSelected);
  const state = useLoad(() => call('memoryList', { status, query }), [status, query]);
  return (
    <Load state={state}>
      {(rows) => (
        <>
          <Panel title="Сначала проверить, затем использовать">
            <p>Только подтверждённые записи публикуются в RAG и граф.</p>
            <div className="toolbar">
              <select
                id="inbox-status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setSelected([]);
                }}
              >
                {[
                  ['pending', 'На проверке'],
                  ['approved', 'Подтверждённые'],
                  ['rejected', 'Отклонённые'],
                  ['merged', 'Объединённые'],
                ].map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                id="inbox-query"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск по заголовку и тексту"
              />
              <Button id="new-memory" onClick={() => memoryEditor(app)}>
                Добавить запись
              </Button>
              <Button
                id="merge-inbox"
                disabled={status !== 'pending' || selected.length < 2}
                onClick={() => {
                  const picked = rows.filter((e: Row) => selected.includes(e.id));
                  app.edit(
                    'Объединить знания',
                    [
                      {
                        name: 'title',
                        label: 'Общий заголовок',
                        required: true,
                        value: picked[0].title,
                      },
                      {
                        name: 'text',
                        label: 'Объединённый текст',
                        type: 'textarea',
                        wide: true,
                        value: picked.map((e: Row) => e.text).join('\n\n---\n\n'),
                      },
                    ],
                    async (v) => {
                      await call('memoryMerge', { ids: picked.map((e: Row) => e.id), ...v });
                      setSelected([]);
                    },
                  );
                }}
              >
                Объединить выбранные
              </Button>
            </div>
          </Panel>
          <div className="cards">
            {rows.map((e: Row) => (
              <article className="skill-card" key={e.id}>
                <div className="section-head">
                  {e.status === 'pending' && (
                    <input
                      type="checkbox"
                      data-select-memory={e.id}
                      checked={selected.includes(e.id)}
                      onChange={(x) =>
                        setSelected((v) =>
                          x.target.checked ? [...v, e.id] : v.filter((id) => id !== e.id),
                        )
                      }
                    />
                  )}
                  <Status value={e.status} />
                </div>
                <h3>{e.title}</h3>
                <p>{short(e.text, 350)}</p>
                <span className="source">
                  {date(e.createdAt)} · {e.collection} · {e.sources.length} источников
                </span>
                <div className="card-actions">
                  <Button data-memory-open={e.id} onClick={() => memoryEditor(app, e)}>
                    {e.status === 'pending' ? 'Проверить и подтвердить' : 'Открыть'}
                  </Button>
                  {e.status !== 'merged' && (
                    <Action
                      onClick={async () => {
                        await call('memoryEdit', {
                          id: e.id,
                          action: e.status === 'pending' ? 'reject' : 'reopen',
                        });
                        app.refresh();
                      }}
                    >
                      {e.status === 'pending' ? 'Отклонить' : 'Вернуть на проверку'}
                    </Action>
                  )}
                </div>
              </article>
            ))}
          </div>
          {!rows.length && <Empty title="Нет записей в этом разделе" />}
        </>
      )}
    </Load>
  );
}
export function QualityPage() {
  const app = useApp(),
    state = useLoad(async () => ({
      h: await call('memoryHygiene'),
      entries: await call('memoryList'),
    }));
  return (
    <Load state={state}>
      {({ h, entries }) => (
        <div className="columns">
          <Panel title="Повторяющиеся входящие">
            {h.duplicates.map((ids: string[], i: number) => (
              <div className="item" key={i}>
                {ids.map((id) => (
                  <p key={id}>{entries.find((e: Row) => e.id === id)?.title || id}</p>
                ))}
                <Button
                  onClick={() =>
                    app.modal('Объединить записи', <InboxPage initialSelected={ids} />)
                  }
                >
                  Выбрать для объединения
                </Button>
              </div>
            ))}
            {!h.duplicates.length && <p>Точных дублей не обнаружено.</p>}
          </Panel>
          <Panel title="Пора перепроверить">
            {h.stale.map((id: string) => (
              <div className="item" key={id}>
                {entries.find((e: Row) => e.id === id)?.title || id}
                <Action
                  onClick={async () => {
                    await call('memoryEdit', { id, action: 'reopen' });
                    app.refresh();
                  }}
                >
                  Вернуть на проверку
                </Action>
              </div>
            ))}
            {!h.stale.length && <p>Нет записей, требующих проверки по возрасту.</p>}
          </Panel>
        </div>
      )}
    </Load>
  );
}
export function DecisionsPage() {
  const app = useApp(),
    state = useLoad(() => call('decisions'));
  return (
    <>
      <div className="toolbar">
        <p className="grow">Решения с основаниями, источниками и проверками.</p>
        <Action id="new-decision" className="primary" onClick={() => decisionEditor(app)}>
          Записать решение
        </Action>
      </div>
      <Load state={state}>
        {(rows) => (
          <>
            {rows.map((e: Row) => (
              <Panel key={e.id} title={e.title} actions={<Status value={e.status} />}>
                <p className="answer">{e.text}</p>
                <h3>Почему так решили</h3>
                <p>{e.reason}</p>
                <p className="source">
                  {date(e.updatedAt)} · {e.sources.length} источников · {e.checks.length} проверок
                </p>
                <div className="toolbar">
                  <Action data-decision-edit={e.id} onClick={() => decisionEditor(app, e)}>
                    Открыть и изменить
                  </Action>
                  <Action
                    onClick={async () => {
                      const b = await call('boardState');
                      taskEditor(app, b.boards[0], null, {
                        title: e.title,
                        description: e.text,
                        decisionIds: [e.id],
                        chatIds: e.chatIds,
                      });
                    }}
                  >
                    Создать задачу
                  </Action>
                  {!!e.versions.length && (
                    <Button onClick={() => app.detail('Предыдущие версии решения', e.versions)}>
                      История решения
                    </Button>
                  )}
                  {e.chatIds.map((id: string) => (
                    <Action
                      key={id}
                      onClick={async () => app.modal('Связанный чат', <ChatView id={id} />)}
                    >
                      Связанный чат
                    </Action>
                  ))}
                </div>
              </Panel>
            ))}
            {!rows.length && <Empty title="Решения ещё не записаны" />}
          </>
        )}
      </Load>
    </>
  );
}
export function RetrievalHistory() {
  const app = useApp(),
    state = useLoad(() => call('searchAudit'));
  const [excluded, setExcluded] = useState<string[]>([]);
  const exclude = (key: string, source: string, nodeId: string, scope: Row) => (
    <Action
      disabled={excluded.includes(key)}
      onClick={async () => {
        await call('sourceExclusion', { action: 'add', source, nodeId, ...scope });
        setExcluded((v) => [...v, key]);
      }}
    >
      {excluded.includes(key) ? 'Источник исключён' : 'Исключить источник'}
    </Action>
  );
  return (
    <Load state={state}>
      {(r) =>
        app.tab === 'excluded' ? (
          <Panel title="Управление источниками">
            <p>
              Исключения действуют в поиске, контексте Nessy и MCP. Исходные документы сохраняются.
            </p>
            {r.exclusions.map((e: Row) => (
              <div className="item" key={e.id}>
                <p>{e.source || e.nodeId}</p>
                <p className="source">
                  {e.collection} · {e.project} · {e.reason}
                </p>
                <Action
                  data-include-source={e.id}
                  onClick={async () => {
                    await call('sourceExclusion', { action: 'remove', id: e.id });
                    app.refresh();
                  }}
                >
                  Снова использовать в поиске
                </Action>
              </div>
            ))}
          </Panel>
        ) : (
          <>
            <p className="muted">
              Результаты локального поиска, подготовленные для Nessy. Доступность контекста не
              гарантирует использование каждого фрагмента.
            </p>
            {r.searches.map((e: Row) => (
              <details className="retrieval-trace" key={e.id}>
                <summary>
                  {short(e.query, 130)}
                  <span className="source">
                    {date(e.at)} · {e.origin} · {e.matches.length} фрагментов
                  </span>
                </summary>
                <p>
                  Каталог: {e.collection} · проект: {e.project || 'Все'} · индекс:{' '}
                  {date(e.indexedAt)}
                </p>
                {e.error && <p className="warning">{e.error}</p>}
                {e.matches.map((m: Row, i: number) => (
                  <article className="result" key={i}>
                    <h3>{m.title}</h3>
                    <p className="answer">{m.text}</p>
                    <p className="source">
                      {m.source} · {m.nodeId}
                    </p>
                    {exclude(e.id + ':' + i, m.source, m.nodeId, {
                      collection: e.collection,
                      project: e.project,
                    })}
                  </article>
                ))}
                {e.graph.map((n: Row) => (
                  <div key={n.id}>
                    <p>
                      {n.label} · {n.source || n.id}
                    </p>
                    {exclude(e.id + ':' + n.id, n.source || '', n.id, {
                      collection: e.collection,
                      project: e.project,
                    })}
                  </div>
                ))}
              </details>
            ))}
            {!r.searches.length && <Empty title="История поиска пока пуста" />}
            {r.skillSelections?.slice(0, 30).map((s: Row, i: number) => (
              <details className="retrieval-trace" key={i}>
                <summary>
                  {date(s.at)} ·{' '}
                  {s.method === 'session-selection'
                    ? 'Выбранный набор сессии'
                    : 'Автоматический подбор'}
                </summary>
                {s.selected.map((x: Row) => (
                  <p key={x.id || x.name}>
                    {x.name} · {x.loaded ? 'текст передан' : 'доступен по запросу'}
                    <br />
                    <span className="source">SHA-256: {x.hash}</span>
                  </p>
                ))}
              </details>
            ))}
          </>
        )
      }
    </Load>
  );
}
