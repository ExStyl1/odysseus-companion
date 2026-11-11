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
  nessyBuilder,
  type Row,
} from '../runtime';
import { Button } from '../components/primitives';
import { customScenarioEditor, scenarioEditor, agentDefinitionEditor } from '../editors';
export function ScenariosPage() {
  const app = useApp(),
    state = useLoad(() => call('scenarioState'));
  const [copyText, setText] = useState(''),
    [format, setFormat] = useState('text'),
    [copied, setCopied] = useState(false);
  return (
    <Load state={state}>
      {(data) => (
        <>
          <div className="scenario-intro">
            <div>
            <span className="eyebrow">ОТ ЗАДАЧИ К РЕЗУЛЬТАТУ</span>
            <h2>С чего начнём?</h2>
            <p>Готовые настройки инструментов и навыков. Подробности Nessy уточнит в чате.</p>
            </div>
          </div>
          <div className="toolbar">
            <Action
              id="new-custom-scenario"
              className="primary"
              onClick={() => customScenarioEditor(app)}
            >
              Создать сценарий
            </Action>
            <Button id="nessy-scenario-builder" onClick={() => nessyBuilder(app, 'scenario')}>
              Создать с Nessy ↗
            </Button>
            <Button
              id="import-custom-scenario"
              onClick={() => {
                let draft: Row;
                app.edit(
                  'Импорт сценария',
                  [
                    {
                      name: 'json',
                      label: 'JSON сценария',
                      type: 'textarea',
                      required: true,
                      wide: true,
                      max: 24000,
                    },
                  ],
                  async (v) => {
                    draft = await call('customScenarioDraft', v);
                  },
                  { submit: 'Проверить черновик', after: () => customScenarioEditor(app, draft) },
                );
              }}
            >
              Импорт JSON
            </Button>
          </div>
          <div className="scenario-grid">
            {data.templates.map((t: Row, i: number) => (
              <article className="scenario-card" key={t.id}>
                <div className="scenario-card-top">
                  <span className="scenario-symbol">✧</span>
                  <span className="source">{String(i + 1).padStart(2, '0')}</span>
                </div>
                <h3>{t.name}</h3>
                {t.custom && <span className="tag">Мой сценарий</span>}
                <p>{t.inputs || t.description}</p>
                <details>
                  <summary>Навыки, MCP и этапы</summary>
                  <p>Навыки: {t.preset?.skills?.join(', ') || 'Встроенные инструкции'}</p>
                  <p>MCP: {t.preset?.mcpNames?.join(', ') || 'Локальная работа'}</p>
                  {!!t.preset?.missing?.length && <p>Недоступны: {t.preset.missing.join(', ')}</p>}
                  <ol>
                    {t.steps.map((s: string) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ol>
                </details>
                <div className="card-actions">
                  <Action
                    className="primary"
                    data-scenario-new={t.id}
                    onClick={async () => {
                      const r = await api.runScenario({ template: t.id });
                      if (r.opened)
                        app.detail(
                          'Сценарий открыт в Nessy',
                          'Навыки и доступные MCP выбраны для этой сессии.',
                        );
                    }}
                  >
                    Открыть в Nessy ↗
                  </Action>
                  <Button
                    data-scenario-nessy={t.id}
                    onClick={() => nessyBuilder(app, 'scenario', t.id)}
                  >
                    Изменить с Nessy
                  </Button>
                  {t.custom && (
                    <>
                      <Action data-custom-edit={t.id} onClick={() => customScenarioEditor(app, t)}>
                        Изменить
                      </Action>
                      <Button
                        onClick={() =>
                          app.edit(
                            'Удалить сценарий?',
                            [],
                            () =>
                              call('customScenarioDelete', {
                                id: t.id,
                                expectedRevision: t.revision,
                              }),
                            {
                              hint: 'Удалится только шаблон. История чатов сохранится.',
                              submit: 'Удалить',
                            },
                          )
                        }
                      >
                        Удалить
                      </Button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
          <h2>Предыдущие запуски</h2>
          {data.runs.map((r: Row) => (
            <article key={r.id} className="scenario-run">
              <div>
                <h3>{r.title}</h3>
                <Status value={r.status} />
                <p className="source">
                  {date(r.updatedAt)} · {r.steps.filter((s: Row) => s.done).length}/{r.steps.length}{' '}
                  этапов
                </p>
              </div>
              <div className="toolbar">
                <Button
                  data-scenario-edit={r.id}
                  onClick={() =>
                    scenarioEditor(
                      app,
                      data,
                      data.templates.find((t: Row) => t.id === r.template),
                      r,
                    )
                  }
                >
                  Открыть
                </Button>
                <Action data-scenario-run={r.id} onClick={() => api.runScenario({ id: r.id })}>
                  В Nessy ↗
                </Action>
                <Button
                  data-scenario-background={r.id}
                  disabled={!r.project || r.status === 'cancelled'}
                  onClick={() => {
                    let queued: any;
                    app.edit(
                      'Выполнить в фоне',
                      [],
                      async () => {
                        queued ||= await call('queueEnqueue', {
                          scenarioId: r.id,
                          source: 'companion',
                          eventId: crypto.randomUUID(),
                        });
                        await call('queueStart', { id: queued.job.id });
                      },
                      {
                        hint: 'Nessy использует текущую модель и разрешения. Запрос расходует токены. Результат потребуется проверить.',
                        submit: 'Запустить Nessy',
                        after: () => app.go('overview', 'queue'),
                      },
                    );
                  }}
                >
                  Выполнить в фоне
                </Button>
                <Action
                  data-scenario-prompt={r.id}
                  onClick={async () =>
                    app.detail(
                      'Запрос по контрольной точке',
                      (await call('scenarioPrompt', { id: r.id })).prompt,
                    )
                  }
                >
                  Показать запрос
                </Action>
              </div>
            </article>
          ))}
          {!data.runs.length && (
            <Empty title="Сценарий продолжится в Nessy">Выберите готового помощника выше.</Empty>
          )}
          <details className="utility-drawer">
            <summary>Импорт отчёта и перенос результата</summary>
            <Action
              id="import-regression"
              onClick={async () => {
                const r = await api.importRegression();
                if (r) app.modal('Разбор импортированного отчёта', <><h3>Импортировано тестов: {r.total} · дубликатов: {r.duplicates}</h3><p>{Object.entries(r.counts).map(([name,count])=>`${name}: ${count}`).join(' · ')}</p><p>{r.method}</p><p>{r.coverage}</p>{r.groups.map((g:Row,i:number)=><section className="detail-section" key={i}><h3>{g.status}</h3><p>{g.message}</p><ul>{g.tests.map((t:Row,j:number)=><li key={j}>{t.name}</li>)}</ul></section>)}</>);
              }}
            >
              Открыть JSON Allure
            </Action>
            <label>
              Текст результата
              <textarea
                id="result-copy-text"
                rows={5}
                maxLength={100000}
                value={copyText}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <div className="toolbar">
              <select
                id="result-copy-format"
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                {[
                  ['text', 'Обычный текст'],
                  ['markdown', 'Markdown'],
                  ['sql', 'SQL без кодовой рамки'],
                  ['wiki', 'Wiki — HTML и текст'],
                ].map(([v, t]) => (
                  <option key={v} value={v}>
                    {t}
                  </option>
                ))}
              </select>
              <Action
                id="result-copy"
                onClick={async () => {
                  await api.copyResult({ text: copyText, format });
                  setCopied(true);
                }}
              >
                Скопировать результат
              </Action>
              <span id="result-copy-status" role="status">
                {copied ? 'Скопировано' : ''}
              </span>
            </div>
          </details>
          {!!data.metrics?.rated && (
            <details className="utility-drawer">
              <summary>Оценки и замеры</summary>
              <p>
                Принято: {data.metrics.accepted}. Средняя оценка:{' '}
                {data.metrics.averageRating?.toFixed(1)}/5.
              </p>
              <p>{data.metrics.method}</p>
            </details>
          )}
        </>
      )}
    </Load>
  );
}
export function QueuePage() {
  const app = useApp(),
    state = useLoad(async () => ({
      data: await call('queueState'),
      scenarios: await call('scenarioState'),
    }));
  return (
    <Load state={state}>
      {({ data, scenarios }) => (
        <>
          <Panel title="Очередь фоновых сценариев">
            <p>Запуск подтверждается отдельно. Результат CLI передаётся на проверку.</p>
            <div className="toolbar">
              <Button
                id="new-queue-job"
                onClick={() => {
                  const eventId = crypto.randomUUID();
                  app.edit(
                    'Добавить событие',
                    [
                      {
                        name: 'scenarioId',
                        label: 'Сохранённый сценарий с проектом',
                        type: 'select',
                        options: scenarios.runs
                          .filter((r: Row) => r.project && r.status !== 'cancelled')
                          .map((r: Row) => [r.id, r.title]),
                      },
                    ],
                    (v) => call('queueEnqueue', { ...v, source: 'companion', eventId }),
                  );
                }}
              >
                Добавить задачу
              </Button>
              <Button id="refresh-queue" onClick={app.refresh}>
                Обновить
              </Button>
            </div>
          </Panel>
          {data.jobs.map((j: Row) => (
            <Panel key={j.id} title={`${j.source} · ${j.eventId}`}>
              <Status value={j.status} />
              <p className="source">
                {j.cwd} · {date(j.at)} · попыток {j.attempts} · лимит {j.timeoutSeconds} секунд
              </p>
              <div className="toolbar">
                {j.status === 'queued' && (
                  <Action
                    data-job-start={j.id}
                    onClick={async () => {
                      await call('queueStart', { id: j.id });
                      app.refresh();
                    }}
                  >
                    Подтвердить запуск
                  </Action>
                )}
                {['queued', 'running'].includes(j.status) && (
                  <Action
                    data-job-cancel={j.id}
                    onClick={async () => {
                      await call('queueCancel', { id: j.id });
                      app.refresh();
                    }}
                  >
                    Отменить
                  </Action>
                )}
                {['failed', 'interrupted'].includes(j.status) && (
                  <Button
                    data-job-retry={j.id}
                    onClick={() =>
                      app.edit(
                        'Повтор после проверки',
                        [
                          {
                            name: 'confirmRetry',
                            label: 'Проверены частичные внешние действия; повтор разрешён',
                            type: 'checkbox',
                          },
                        ],
                        (v) => call('queueRetry', { ...v, id: j.id }),
                        { hint: 'Повтор может повторить уже выполненное внешнее действие.' },
                      )
                    }
                  >
                    Проверить повтор
                  </Button>
                )}
                {j.output && (
                  <Button
                    data-job-output={j.id}
                    onClick={() => app.detail('Вывод штатного Nessy', j.output)}
                  >
                    Результат CLI
                  </Button>
                )}
              </div>
            </Panel>
          ))}
        </>
      )}
    </Load>
  );
}
export function AgentsPage() {
  const app = useApp(),
    state = useLoad(() => call(app.tab === 'runs' ? 'agentRuns' : 'agentDefinitions'), [app.tab]);
  const [query, setQuery] = useState('');
  return (
    <Load state={state}>
      {(data) =>
        app.tab === 'runs' ? (
          <AgentRuns data={data} />
        ) : (
          <>
            <div className="agent-catalog-head">
              <div>
                <h3>Ваша команда Nessy</h3>
                <p>У каждого специалиста — задача, инструкции и инструменты.</p>
              </div>
              <div className="section-actions">
                <Button id="new-agent-nessy" onClick={() => nessyBuilder(app, 'agent')}>
                  Создать с Nessy ↗
                </Button>
                <Button
                  id="new-agent-definition"
                  className="primary"
                  onClick={() => agentDefinitionEditor(app, data)}
                >
                  Создать субагента
                </Button>
              </div>
            </div>
            <Panel>
              <strong>Настройки применяются в профиле Nessy</strong>
              <p className="source">
                Права, модель и лимиты записываются в agents/*.md. Подтверждения зависят также от
                родительской сессии. После изменения перезапустите Nessy.
              </p>
            </Panel>
            <input
              className="oc-full"
              id="agent-definition-query"
              placeholder="Найти роль, задачу или инструмент"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div id="agent-definition-cards" className="cards">
              {data.definitions
                .filter((d: Row) =>
                  (d.title + ' ' + d.name + ' ' + d.description + ' ' + d.tools.join(' '))
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((d: Row) => (
                  <article className="skill-card" key={d.name}>
                    <Status value={d.status} />
                    <h3>{d.title}</h3>
                    <span className="source">
                      {d.name} · {d.preset ? 'Шаблон Odysseus' : 'Своя роль'}
                    </span>
                    <p>{d.description}</p>
                    <div className="agent-capabilities">
                      <span>{d.tools.join(', ')}</span>
                      <span>{d.maxTurns} шагов</span>
                      <span>{d.maxMinutes} мин</span>
                      <span>{d.mcpServers.length} MCP</span>
                    </div>
                    <div className="card-actions">
                      <Button
                        data-agent-nessy={d.name}
                        onClick={() => nessyBuilder(app, 'agent', d.name)}
                      >
                        Изменить с Nessy
                      </Button>
                      <Button
                        data-agent-edit={d.name}
                        onClick={() => agentDefinitionEditor(app, data, d)}
                      >
                        Настроить
                      </Button>
                      <Button
                        data-agent-copy={d.name}
                        onClick={() => agentDefinitionEditor(app, data, d, true)}
                      >
                        Создать копию
                      </Button>
                      <Button
                        data-agent-native={d.name}
                        onClick={() => app.detail('Файл Nessy: ' + d.name, d.nativeContent)}
                      >
                        Файл Nessy
                      </Button>
                      {!!d.versions.length && (
                        <Button
                          data-agent-history={d.name}
                          onClick={() => app.detail('История настроек', d.versions)}
                        >
                          Версии · {d.versions.length}
                        </Button>
                      )}
                      <Action
                        onClick={async () => {
                          if (
                            !confirm(
                              d.preset
                                ? 'Восстановить шаблон с резервной копией?'
                                : 'Удалить роль с резервной копией?',
                            )
                          )
                            return;
                          await call(d.preset ? 'agentDefinitionReset' : 'agentDefinitionDelete', {
                            name: d.name,
                            expectedUpdatedAt: d.updatedAt,
                          });
                          app.refresh();
                        }}
                      >
                        {d.preset ? 'Сбросить к шаблону' : 'Удалить роль'}
                      </Action>
                    </div>
                  </article>
                ))}
            </div>
            <Panel title="Как работает команда">
              <p>Исследование → анализ → реализация → проверки → контроль результата.</p>
              <div className="toolbar">
                <Action
                  id="agent-skill"
                  onClick={async () => {
                    const skills = await call('skills'),
                      s = skills.find((s: Row) => s.name === 'odysseus-subagents');
                    app.detail(
                      'Навык координации',
                      s
                        ? (await call('skill', { id: s.id })).content
                        : 'Установите расширение Companion во вкладке MCP и плагины.',
                    );
                  }}
                >
                  Открыть навык координации
                </Action>
                <Button id="agent-install" onClick={() => app.go('mcp')}>
                  Установка в другой профиль
                </Button>
              </div>
            </Panel>
          </>
        )
      }
    </Load>
  );
}
function AgentRuns({ data }: { data: Row }) {
  const app = useApp();
  return (
    <Panel
      title="Планы и результаты этапов"
      actions={
        <Button
          id="new-agent-plan"
          onClick={() =>
            app.edit(
              'План работы команды',
              [
                { name: 'title', label: 'Задача', required: true },
                { name: 'project', label: 'Путь проекта' },
                { name: 'sessionId', label: 'ID чата, если известен' },
                {
                  name: 'stages',
                  label: 'Этапы JSON: id, title, role, dependsOn, files, budget',
                  type: 'textarea',
                  wide: true,
                  rows: 14,
                  value: JSON.stringify(
                    [
                      {
                        id: 'analysis',
                        title: 'Исследовать задачу',
                        role: 'analyst',
                        dependsOn: [],
                        files: [],
                        budget: 3,
                      },
                      {
                        id: 'dev',
                        title: 'Реализовать',
                        role: 'developer',
                        dependsOn: ['analysis'],
                        files: [],
                        budget: 3,
                      },
                      {
                        id: 'qa',
                        title: 'Проверить результат',
                        role: 'qa',
                        dependsOn: ['dev'],
                        files: [],
                        budget: 3,
                      },
                    ],
                    null,
                    2,
                  ),
                },
              ],
              (v) => call('agentPlan', { ...v, stages: JSON.parse(v.stages) }),
              { hint: 'План не запускает модель. Nessy обновляет этапы через MCP.' },
            )
          }
        >
          Создать план
        </Button>
      }
    >
      <p className="muted">
        План не запускает модель. Наблюдаемые события запуска отделены от отчётов агента.
      </p>
      {data.runs.map((r: Row) => (
        <article key={r.id} className="run-card">
          <h3>{r.title}</h3>
          <p>
            {r.project} · {date(r.updatedAt)}
          </p>
          <div className="stage-list">
            {r.stages.map((s: Row) => (
              <div className="stage-row" key={s.id}>
                <div>
                  <strong>{s.title}</strong>
                  <p>
                    {s.role} · зависит от: {s.dependsOn.join(', ') || 'нет'} · попытки {s.attempts}/
                    {s.budget}
                  </p>
                  <p className="source">{s.files.join(', ')}</p>
                </div>
                <Status value={s.status} />
              </div>
            ))}
          </div>
          <Button
            data-run={r.id}
            onClick={() =>
              app.modal(
                r.title,
                <>
                  <p>runId: {r.id}</p>
                  {r.stages.map((s: Row) => (
                    <section className="detail-section" key={s.id}>
                      <h3>{s.title}</h3>
                      <Status value={s.status} />
                      <p className="answer">{s.report || 'Отчёт не получен'}</p>
                      <p>Файлы по отчёту: {s.changedFiles?.join(', ') || 'Нет данных'}</p>
                      {(s.checks || []).map((c: Row, i: number) => (
                        <div className="result" key={i}>
                          <strong>{c.command}</strong>
                          <Status value={c.status} />
                          <p>Со слов агента; подтверждающий вывод:</p>
                          <pre>{c.output || 'Не приложен'}</pre>
                        </div>
                      ))}
                    </section>
                  ))}
                </>,
              )
            }
          >
            Открыть отчёты и проверки
          </Button>
        </article>
      ))}
      {!data.runs.length && <Empty title="Пока нет планов" />}
      <h3>Наблюдаемые запуски Nessy</h3>
      {data.events.slice(0, 50).map((e: Row, i: number) => (
        <div className="item" key={i}>
          <strong>{e.role}</strong> <Status value={e.status} />
          <p className="source">
            Агент: {e.id} · Сессия: {e.sessionId} · {date(e.updatedAt)}
          </p>
          {e.summary && (
            <details>
              <summary>Итог субагента</summary>
              <p className="answer">{e.summary}</p>
            </details>
          )}
        </div>
      ))}
      {!data.events.length && (
        <p className="source">
          События появятся после SubagentStart/SubagentStop в Nessy с установленным расширением.
        </p>
      )}
    </Panel>
  );
}
