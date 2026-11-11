import { useState } from 'react';
import {
  Action,
  Panel,
  Empty,
  Load,
  useLoad,
  useApp,
  call,
  api,
  date,
  short,
  csv,
  priorities,
  type Row,
  type Field,
} from '../runtime';
import { Button } from '../components/primitives';
export function TodayPage() {
  const app = useApp();
  const state = useLoad(async () => ({ usage: await call('usage'), p: await call('personal') }));
  return <Load state={state}>{(d) => <Today data={d} />}</Load>;
}
function Today({ data: { usage, p } }: { data: any }) {
  const app = useApp(),
    today = new Date().toLocaleDateString('sv-SE');
  const [metric, setMetric] = useState('sessions'),
    [day, setDay] = useState(today),
    [month, setMonth] = useState(today.slice(0, 7)),
    [drafts, setDrafts] = useState<Row>({}),
    [saved, setSaved] = useState('');
  const d = usage.days.find((d: Row) => d.date === today),
    total = usage.sessions.reduce((n: number, s: Row) => n + (s.totalTokens || 0), 0);
  const [y, m] = month.split('-').map(Number),
    first = new Date(y, m - 1, 1, 12),
    shift = (first.getDay() + 6) % 7,
    count = new Date(y, m, 0).getDate();
  const days = Array.from({ length: 28 }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - 27 + i);
    const key = date.toLocaleDateString('sv-SE');
    return { date: key, ...usage.days.find((d: Row) => d.date === key) };
  });
  const max = Math.max(1, ...days.map((d) => Number(d[metric] || 0)));
  return (
    <>
      <div className="home-start">
        <div>
        <span className="eyebrow">ВАШ ПОМОЩНИК</span>
        <h2>Освободите время для главного</h2>
        <p>Разобрать требования, проверить код или подготовить релиз.</p>
        </div>
        <Button onClick={() => app.go('overview', 'scenarios')}>Выбрать сценарий →</Button>
      </div>
      <div className="metrics">
        {[
          [d?.sessions || 0, 'Сессии сегодня'],
          [d?.tokens || 0, 'Токены сегодня'],
          [usage.observer.captured, 'Записи в памяти'],
          [total, 'Всего токенов'],
        ].map(([n, t]) => (
          <div className="metric" key={t}>
            <div className="metric-label">{t}</div>
            <strong>{Number(n).toLocaleString('ru')}</strong>
          </div>
        ))}
      </div>
      <div className="home-grid">
        <div>
          <Panel
            title="Активность Nessy"
            actions={
              <div className="segmented">
                {['sessions', 'tokens'].map((id) => (
                  <Button
                    key={id}
                    data-activity={id}
                    className={metric === id ? 'selected' : ''}
                    onClick={() => setMetric(id)}
                  >
                    {id === 'sessions' ? 'Сессии' : 'Токены'}
                  </Button>
                ))}
              </div>
            }
          >
            <svg viewBox="0 0 560 150" role="img" aria-label="Активность Nessy за 28 дней">
              {days.map((d, i) => (
                <g key={d.date}>
                  <rect
                    x={i * 20 + 3}
                    y={130 - (120 * Number(d[metric] || 0)) / max}
                    width="12"
                    height={Math.max(2, (120 * Number(d[metric] || 0)) / max)}
                    rx="3"
                    fill="var(--accent)"
                  >
                    <title>
                      {d.date}: {d[metric] || 0}
                    </title>
                  </rect>
                </g>
              ))}
            </svg>
          </Panel>
          <Panel title="Последние сессии">
            {usage.sessions.slice(0, 8).map((s: Row, i: number) => (
              <div className="item" key={i}>
                <strong>{date(s.start)}</strong>
                <p>{s.totalTokens == null ? 'Токены не записаны' : s.totalTokens + ' токенов'}</p>
                <p className="source">
                  {s.project} · {s.messages} сообщений · Вход: {s.inputTokens ?? '—'} · Выход:{' '}
                  {s.outputTokens ?? '—'}
                </p>
              </div>
            ))}
            {!usage.sessions.length && (
              <Empty title="Начало вашей истории">
                Новые сессии появятся после работы в Nessy.
              </Empty>
            )}
          </Panel>
        </div>
        <Panel
          title={first.toLocaleDateString('ru', { month: 'long', year: 'numeric' })}
          actions={
            <div className="row">
              {[-1, 1].map((n) => (
                <Button
                  key={n}
                  id={n < 0 ? 'month-prev' : 'month-next'}
                  onClick={() =>
                    setMonth(new Date(y, m - 1 + n, 1, 12).toLocaleDateString('sv-SE').slice(0, 7))
                  }
                >
                  {n < 0 ? '‹' : '›'}
                </Button>
              ))}
            </div>
          }
        >
          <div id="calendar" className="calendar">
            {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((t) => (
              <small key={t}>{t}</small>
            ))}
            {Array.from({ length: shift }, (_, i) => (
              <span key={'s' + i} />
            ))}
            {Array.from({ length: count }, (_, i) => {
              const key = month + '-' + String(i + 1).padStart(2, '0');
              return (
                <Button
                  key={key}
                  data-day={key}
                  aria-label={key}
                  className={`${key === day ? 'selected' : ''} ${p.notes?.[key] ? 'has-note' : ''} ${(p.releaseEvents || []).some((e: Row) => e.date === key) ? 'has-release' : ''}`}
                  onClick={() => {
                    setDay(key);
                    setSaved('');
                  }}
                >
                  {i + 1}
                </Button>
              );
            })}
          </div>
          <div id="calendar-events">
            {(p.releaseEvents || [])
              .filter((e: Row) => e.date === day)
              .map((e: Row, i: number) => (
                <p key={i}>
                  {e.title} · {e.owner}
                </p>
              ))}
          </div>
          <label htmlFor="calendar-note">Заметка · {day}</label>
          <textarea
            id="calendar-note"
            value={drafts[day] ?? p.notes?.[day]?.text ?? ''}
            onChange={(e) => setDrafts((v) => ({ ...v, [day]: e.target.value }))}
          />
          <div className="note-actions">
            <span role="status">{saved}</span>
            <Action
              id="save-calendar"
              onClick={async () => {
                const next = await call('personalUpdate', {
                  date: day,
                  text: drafts[day] ?? p.notes?.[day]?.text ?? '',
                });
                app.setPreferences(next);
                setSaved('Сохранено на компьютере');
                app.refresh();
              }}
            >
              Сохранить заметку
            </Action>
          </div>
        </Panel>
      </div>
      <Panel
        title={
          usage.observer.enabled ? 'Память Companion обновляется' : 'Запись в память приостановлена'
        }
      >
        <p>{usage.observer.error || 'Последняя запись: ' + date(usage.observer.lastCapturedAt)}</p>
        <div className="toolbar">
          <Action
            id="toggle-observer"
            onClick={async () => {
              await call('observerConfigure', { enabled: !usage.observer.enabled });
              app.refresh();
            }}
          >
            {usage.observer.enabled ? 'Приостановить' : 'Возобновить'}
          </Action>
          <Button onClick={() => app.go('mcp')}>Настроить Nessy</Button>
        </div>
      </Panel>
    </>
  );
}
export function taskEditor(
  app: ReturnType<typeof useApp>,
  b: Row,
  t: Row | null = null,
  seed: Row = {},
) {
  const v = { ...seed, ...t };
  app.edit(
    t ? 'Моя задача' : 'Новая задача',
    [
      {
        name: 'title',
        label: 'Что нужно сделать?',
        required: true,
        max: 200,
        value: v.title,
        wide: true,
      },
      {
        name: 'description',
        label: 'Заметка',
        type: 'textarea',
        wide: true,
        value: v.description,
        max: 12000,
      },
      {
        name: 'columnId',
        label: 'Статус',
        type: 'select',
        value: v.columnId || b.columns[0].id,
        options: b.columns.map((c: Row) => [c.id, c.name]),
      },
      { name: 'due', label: 'Срок (необязательно)', type: 'date', value: v.due },
      {
        name: 'priority',
        label: 'Приоритет',
        type: 'select',
        value: v.priority || 'normal',
        options: Object.entries(priorities),
        group: 'Дополнительно',
      },
      {
        name: 'labels',
        label: 'Метки через запятую',
        value: (v.labels || []).join(', '),
        group: 'Дополнительно',
      },
    ],
    (f) =>
      call('boardTask', {
        ...v,
        ...f,
        action: 'save',
        boardId: b.id,
        id: t?.id,
        expectedUpdatedAt: t?.updatedAt,
        labels: csv(f.labels),
      }),
    {
      hint: 'Личная задача. Nessy не запускается.',
      actions: t && (
        <Action
          onClick={async () => {
            await call('boardTask', {
              boardId: b.id,
              id: t.id,
              action: t.archived ? 'restore' : 'archive',
            });
            app.close();
            app.refresh();
          }}
        >
          {t.archived ? 'Вернуть из архива' : 'В архив'}
        </Action>
      ),
    },
  );
}
export function BoardPage() {
  const app = useApp();
  const state = useLoad(() => call('boardState'));
  const [selected, setSelected] = useState(''),
    [query, setQuery] = useState(''),
    [archived, setArchived] = useState(false);
  return (
    <Load state={state}>
      {(data) => {
        const b = data.boards.find((b: Row) => b.id === selected) || data.boards[0];
        if (!b) return <Empty />;
        return (
          <>
            <div className="toolbar">
              <select id="board-select" value={b.id} onChange={(e) => setSelected(e.target.value)}>
                {data.boards.map((b: Row) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <Button
                id="new-board"
                onClick={() =>
                  app.edit(
                    'Новая доска',
                    [{ name: 'name', label: 'Название', required: true }],
                    (v) => call('boardConfigure', { action: 'create', ...v }),
                  )
                }
              >
                Новая доска
              </Button>
              <input
                id="board-query"
                className="grow"
                placeholder="Найти задачу по названию или метке"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <label className="row">
                <input
                  type="checkbox"
                  id="board-archived"
                  checked={archived}
                  onChange={(e) => setArchived(e.target.checked)}
                />
                Архив
              </label>
              <Button
                id="configure-board"
                onClick={() => app.modal('Настройки доски', <BoardSettings board={b} />)}
              >
                Настроить доску
              </Button>
              <Button id="new-task" className="primary" onClick={() => taskEditor(app, b)}>
                Новая задача
              </Button>
            </div>
            <div className="kanban" id="kanban">
              {b.columns.map((c: Row) => {
                const tasks = b.tasks
                  .filter(
                    (t: Row) =>
                      t.columnId === c.id &&
                      !!t.archived === archived &&
                      (t.title + ' ' + t.description + ' ' + t.labels.join(' '))
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                  )
                  .sort((a: Row, b: Row) => a.order - b.order);
                return (
                  <section
                    className="kanban-column"
                    key={c.id}
                    data-column={c.id}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const id = e.dataTransfer.getData('text/plain'),
                        before = (e.target as Element)
                          .closest('[data-task-id]')
                          ?.getAttribute('data-task-id');
                      if (!archived && id && id !== before)
                        void app.run(async () => {
                          await call('boardTask', {
                            action: 'move',
                            boardId: b.id,
                            id,
                            columnId: c.id,
                            beforeId: before || undefined,
                          });
                          app.refresh();
                        });
                    }}
                  >
                    <div className="kanban-heading">
                      <i style={{ background: c.color }} />
                      <h3>{c.name}</h3>
                      <span>{tasks.length}</span>
                      <Button
                        data-add-task={c.id}
                        onClick={() => taskEditor(app, b, null, { columnId: c.id })}
                      >
                        +
                      </Button>
                    </div>
                    <div className="kanban-cards">
                      {tasks.map((t: Row) => (
                        <article
                          key={t.id}
                          data-task-id={t.id}
                          className="task-card"
                          draggable={!archived}
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') taskEditor(app, b, t);
                          }}
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/plain', t.id);
                            e.dataTransfer.effectAllowed = 'move';
                          }}
                        >
                          <div className="task-labels">
                            {t.labels.map((l: string) => (
                              <span
                                className="tag"
                                key={l}
                                style={{ color: b.labels.find((x: Row) => x.name === l)?.color }}
                              >
                                {l}
                              </span>
                            ))}
                          </div>
                          <h3>{t.title}</h3>
                          <p>{short(t.description, 150)}</p>
                          <div className="task-meta">
                            {priorities[t.priority as keyof typeof priorities]} {t.due}
                          </div>
                          <div className="task-footer">
                            <span>
                              Чаты: {t.chatIds.length} · Решения: {t.decisionIds.length}
                            </span>
                            <Button data-edit-task={t.id} onClick={() => taskEditor(app, b, t)}>
                              Открыть
                            </Button>
                          </div>
                        </article>
                      ))}
                      {!tasks.length && (
                        <div className="column-empty">
                          Перетащите задачу сюда или создайте новую
                        </div>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          </>
        );
      }}
    </Load>
  );
}
function BoardSettings({ board: b }: { board: Row }) {
  const app = useApp();
  const [name, setName] = useState(b.name),
    [columns, setColumns] = useState<Row[]>(structuredClone(b.columns)),
    [labels, setLabels] = useState<Row[]>(structuredClone(b.labels)),
    [move, setMove] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      id="board-settings"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
          await call('boardConfigure', {
            id: b.id,
            name,
            columns,
            labels,
            moveTo: move,
            expectedRevision: b.revision,
          });
          app.close();
          app.refresh();
        } catch (e: any) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        Название
        <input
          id="board-name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
        />
      </label>
      <h3>Колонки</h3>
      {columns.map((c, n) => (
        <div key={c.id} className="column-editor">
          <input
            data-col-name={n}
            required
            value={c.name}
            onChange={(e) =>
              setColumns((v) => v.map((x, i) => (i === n ? { ...x, name: e.target.value } : x)))
            }
          />
          <input
            type="color"
            data-col-color={n}
            value={c.color}
            onChange={(e) =>
              setColumns((v) => v.map((x, i) => (i === n ? { ...x, color: e.target.value } : x)))
            }
          />
          {[-1, 1].map((delta) => (
            <Button
              key={delta}
              disabled={n + delta < 0 || n + delta >= columns.length}
              onClick={() =>
                setColumns((v) => {
                  const a = [...v];
                  [a[n], a[n + delta]] = [a[n + delta], a[n]];
                  return a;
                })
              }
            >
              {delta < 0 ? '↑' : '↓'}
            </Button>
          ))}
          <Button onClick={() => setColumns((v) => v.filter((_, i) => i !== n))}>Удалить</Button>
        </div>
      ))}
      <Button
        id="add-column"
        onClick={() =>
          setColumns((v) => [
            ...v,
            { id: crypto.randomUUID(), name: 'Новая колонка', color: '#9a9a9a' },
          ])
        }
      >
        Добавить колонку
      </Button>
      <label>
        Перенести задачи из удалённых колонок
        <select value={move} onChange={(e) => setMove(e.target.value)}>
          <option value="">Выберите при необходимости</option>
          {columns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <h3>Метки</h3>
      {labels.map((l, n) => (
        <div className="column-editor" key={n}>
          <input
            required
            value={l.name}
            onChange={(e) =>
              setLabels((v) => v.map((x, i) => (i === n ? { ...x, name: e.target.value } : x)))
            }
          />
          <input
            type="color"
            value={l.color}
            onChange={(e) =>
              setLabels((v) => v.map((x, i) => (i === n ? { ...x, color: e.target.value } : x)))
            }
          />
          <Button onClick={() => setLabels((v) => v.filter((_, i) => i !== n))}>Удалить</Button>
        </div>
      ))}
      <Button
        id="add-board-label"
        onClick={() => setLabels((v) => [...v, { name: 'Новая метка', color: '#c8a66d' }])}
      >
        Добавить метку
      </Button>
      <p role="alert" id="board-settings-error">
        {error}
      </p>
      <Button type="submit" className="primary" disabled={busy}>
        Сохранить настройки
      </Button>
    </form>
  );
}
function Rating({ id, value = 0 }: { id: string; value?: number }) {
  const app = useApp();
  return (
    <div className="chat-rating" data-rating-id={id}>
      <div className="rating-stars" role="group" aria-label="Оценка полезности разговора">
        {[1, 2, 3, 4, 5].map((n) => (
          <Action
            key={n}
            data-rate={n}
            aria-label={`${n} из 5`}
            aria-pressed={n === value}
            className={'rating-star ' + (n <= value ? 'selected' : '')}
            onClick={async () => {
              await call('chatRate', { id, rating: n === value ? 0 : n });
              app.refresh();
            }}
          >
            ★
          </Action>
        ))}
      </div>
      <span>{value ? value + ' из 5' : 'Без оценки'}</span>
    </div>
  );
}
export function ChatsPage() {
  const app = useApp();
  const [filter, setFilter] = useState<Row>({
      query: '',
      project: '',
      from: '',
      to: '',
      folder: '',
      minRating: '',
      sort: 'recent',
      offset: 0,
    }),
    [selected, setSelected] = useState('');
  const state = useLoad(() => call('chatList', filter), [JSON.stringify(filter)]);
  return (
    <Load state={state}>
      {(r) => (
        <>
          <div className="section-head">
            <h2>Разговоры, к которым стоит вернуться</h2>
            <Button
              id="new-chat-folder"
              onClick={() =>
                app.edit(
                  'Новая папка разговоров',
                  [{ name: 'name', label: 'Название папки', required: true, max: 60 }],
                  async (v) => {
                    const f = await call('chatOrganize', { action: 'create', name: v.name });
                    setFilter({ ...filter, folder: f.id, offset: 0 });
                  },
                )
              }
            >
              Новая папка
            </Button>
          </div>
          <Panel>
            <label>
              Автоматически распределять
              <select
                id="chat-auto-mode"
                value={r.organization?.mode || 'none'}
                onChange={(e) =>
                  void app.run(async () => {
                    await call('chatOrganize', { action: 'mode', mode: e.target.value });
                    setFilter({ ...filter, folder: '', offset: 0 });
                    app.refresh();
                  })
                }
              >
                <option value="topic">По теме разговора</option>
                <option value="project">По проекту</option>
                <option value="none">Только вручную</option>
              </select>
            </label>
          </Panel>
          <div className="chat-folders">
            {[
              { id: '', name: 'Все разговоры', count: r.allTotal ?? r.total },
              ...(r.folders || []),
            ].map((f: Row) => (
              <Button
                key={f.id}
                data-chat-folder={f.id}
                className={filter.folder === f.id ? 'selected' : ''}
                onClick={() => {
                  setFilter({ ...filter, folder: f.id, offset: 0 });
                  setSelected('');
                }}
              >
                {f.name} · {f.count}
              </Button>
            ))}
          </div>
          {(r.customFolders || []).some((f: Row) => f.id === filter.folder) && (
            <div className="toolbar">
              <Button
                onClick={() =>
                  app.edit(
                    'Переименовать папку',
                    [
                      {
                        name: 'name',
                        label: 'Название',
                        required: true,
                        value: r.customFolders.find((f: Row) => f.id === filter.folder).name,
                      },
                    ],
                    (v) =>
                      call('chatOrganize', {
                        action: 'rename',
                        folderId: filter.folder,
                        name: v.name,
                      }),
                  )
                }
              >
                Переименовать папку
              </Button>
              <Action
                onClick={async () => {
                  if (!confirm('Удалить папку? Разговоры сохранятся.')) return;
                  await call('chatOrganize', { action: 'delete', folderId: filter.folder });
                  setFilter({ ...filter, folder: '', offset: 0 });
                  app.refresh();
                }}
              >
                Удалить папку
              </Action>
            </div>
          )}
          <form
            id="chat-search"
            className="toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              setFilter({
                ...filter,
                ...Object.fromEntries(new FormData(e.currentTarget)),
                offset: 0,
              });
            }}
          >
            <input
              name="query"
              id="chat-query"
              placeholder="Название чата или папка проекта"
              defaultValue={filter.query}
            />
            <select name="project" defaultValue={filter.project}>
              <option value="">Все проекты</option>
              {r.projects.map((p: string) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <input name="from" type="date" defaultValue={filter.from} aria-label="С даты" />
            <input name="to" type="date" defaultValue={filter.to} aria-label="По дату" />
            <select name="minRating" defaultValue={filter.minRating}>
              <option value="">Любая оценка</option>
              {[3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  От {n} звёзд
                </option>
              ))}
            </select>
            <select name="sort" defaultValue={filter.sort}>
              <option value="recent">Сначала новые</option>
              <option value="rating">Сначала полезные</option>
            </select>
            <Button type="submit">Найти</Button>
          </form>
          {r.data.map((c: Row) => (
            <article key={c.id} className="chat-row">
              <div className="chat-summary">
                <h3>{c.title}</h3>
                <span className="tag">
                  {c.folder?.name || 'Без папки'}
                  {c.folderManual ? ' · вручную' : ''}
                </span>
                <p className="source">
                  {c.project} · {c.profileName} · {date(c.updatedAt)} · {c.messageCount} сообщений ·{' '}
                  {c.totalTokens ?? '—'} токенов
                </p>
                <Rating id={c.id} value={c.rating} />
                {c.unavailable && <p>{c.unavailable}</p>}
              </div>
              <Button data-chat={c.id} onClick={() => setSelected(c.id)}>
                Открыть чат
              </Button>
            </article>
          ))}
          {!r.data.length && <Empty title="Нет разговоров для этого фильтра" />}
          <div className="pager">
            <Button
              disabled={!filter.offset}
              onClick={() => setFilter({ ...filter, offset: Math.max(0, filter.offset - 30) })}
            >
              Назад
            </Button>
            <span>{r.total} чатов</span>
            <Button
              disabled={filter.offset + r.limit >= r.total}
              onClick={() => setFilter({ ...filter, offset: filter.offset + 30 })}
            >
              Далее
            </Button>
          </div>
          {selected && <ChatView key={selected} id={selected} />}
        </>
      )}
    </Load>
  );
}
export function ChatView({ id }: { id: string }) {
  const app = useApp();
  const [offset, setOffset] = useState(0);
  const state = useLoad(() => call('chatRead', { id, offset }), [id, offset]);
  return (
    <Load state={state}>
      {(r) => (
        <section id="chat-view" className="panel chat-transcript">
          <h2>{r.title}</h2>
          <p className="source">
            {r.project} · {date(r.startedAt)} · {r.total} сообщений
          </p>
          <div className="toolbar">
            {[
              ['resume', 'Продолжить чат'],
              ['fork', 'Новая ветка чата'],
              ['repeat', 'Повторить последний запрос'],
              ['new', 'Начать заново'],
            ].map(([mode, label]) => (
              <Action
                key={mode}
                data-launch-chat={mode}
                onClick={async () => {
                  if (mode === 'repeat') {
                    const p = await call('chatLaunch', { id, mode });
                    app.edit(
                      'Повторить запрос',
                      [
                        {
                          name: 'prompt',
                          label: 'Запрос для новой сессии',
                          type: 'textarea',
                          wide: true,
                          required: true,
                          value: p.prompt,
                          max: 24000,
                        },
                      ],
                      (v) => api.runChat({ id, mode, prompt: v.prompt }),
                      {
                        submit: 'Запустить в Nessy',
                        hint: p.promptTruncated
                          ? 'Показан фрагмент большого запроса. Проверьте его перед запуском.'
                          : 'Запрос откроется в новой сессии; оригинал сохранится.',
                      },
                    );
                  } else await api.runChat({ id, mode });
                }}
              >
                {label}
              </Action>
            ))}
            <Action
              onClick={async () => {
                const boards = await call('boardState');
                taskEditor(app, boards.boards[0], null, {
                  title: r.title,
                  chatIds: [id],
                  project: r.project,
                });
              }}
            >
              Создать задачу
            </Action>
          </div>
          <Rating id={id} value={r.rating} />
          <label>
            Папка разговора
            <select
              id="conversation-folder"
              value={r.folderManual ? r.folder.id : 'auto'}
              onChange={(e) =>
                void app.run(async () => {
                  await call('chatOrganize', { action: 'move', id, folderId: e.target.value });
                  app.refresh();
                })
              }
            >
              <option value="auto">Автоматически · {r.automaticFolder?.name}</option>
              <option value="other">Без папки · вручную</option>
              {(r.customFolders || []).map((f: Row) => (
                <option value={f.id} key={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          {r.messages.map((m: Row, i: number) => (
            <article className={`chat-message ${m.role}`} key={i}>
              <div className="chat-message-head">
                <strong>{m.role === 'user' ? 'Вы' : 'Nessy'}</strong>
                <span>
                  {date(m.at)} · {m.model}
                </span>
              </div>
              <div className="answer">{m.text}</div>
              {(m.commands || []).map((c: Row, j: number) => (
                <div className="cli-activity" key={j}>
                  {c.tool?.image && <img src={c.tool.image} alt={c.tool.displayName} />}
                  <div>
                    <span className="source">{c.tool?.displayName || 'CLI-команда'}</span>
                    <pre>{c.command}</pre>
                  </div>
                </div>
              ))}
            </article>
          ))}
          <div className="pager">
            <Button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 100))}>
              Ранее
            </Button>
            <span>
              {offset + 1}–{Math.min(offset + r.limit, r.total)} из {r.total}
            </span>
            <Button disabled={offset + r.limit >= r.total} onClick={() => setOffset(offset + 100)}>
              Позже
            </Button>
          </div>
        </section>
      )}
    </Load>
  );
}
