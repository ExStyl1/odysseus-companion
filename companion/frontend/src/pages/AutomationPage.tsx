import { useEffect, useState } from 'react';
import {
  Action,
  call,
  api,
  date,
  Empty,
  Json,
  Load,
  Panel,
  useApp,
  useLoad,
  type Row,
} from '../runtime';
import { Graph } from '../components/Graph';
export function AutomationPage() {
  return <CorporateN8n />;
}

function Workflow({ workflow }: { workflow: Row }) {
  const app = useApp();
  const links: Row[] = [];
  for (const [source, outputs] of Object.entries(workflow.connections || {}))
    for (const rows of Object.values(outputs as Row))
      for (const items of rows as any[])
        for (const item of items || []) links.push({ source, target: item.node, relation: item.type });
  return (
    <Panel title={workflow.name}>
      <Action onClick={() => api.openCorporateN8n(workflow.id)}>Открыть процесс в n8n ↗</Action>
      <Graph
        flow
        nodes={(workflow.nodes || []).map((node: Row) => ({ ...node, id: node.name, label: node.name }))}
        links={links}
        onSelect={(node) => app.detail(node.name, node)}
      />
      <details>
        <summary>Схема JSON</summary>
        <Json value={workflow} />
      </details>
    </Panel>
  );
}
function CorporateN8n() {
  const app = useApp(),
    [query, setQuery] = useState(''),
    [workflow, setWorkflow] = useState<Row | null>(null),
    [tick, setTick] = useState(0);
  const state = useLoad(
    async () => ({
      state: await call('corporateStatus'),
      snapshot: await call('corporateWorkflows'),
    }),
    [tick],
  );
  useEffect(() => {
    if (state.loading) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') setTick((n) => n + 1);
    }, 15000);
    return () => clearInterval(timer);
  }, [state.loading, tick]);
  return (
    <Load state={state}>
      {({ state: s, snapshot }) => (
        <>
          <Panel
            title={s.hasApiKey ? 'Корпоративный снимок процессов' : 'Корпоративный API не настроен'}
          >
            <div className="toolbar">
              <span className="tag">{s.baseUrl}</span>
              <button id="corporate-settings" onClick={() => app.edit(
                'Подключение к корпоративному n8n',
                [
                  { name: 'apiKey', label: 'Ключ Public API', type: 'password', max: 16000,
                    hint: s.hasApiKey ? 'Оставьте поле пустым, чтобы сохранить текущий ключ.' : 'Ключ с правами чтения процессов и запусков.' },
                  { name: 'autoSync', label: 'Обновлять снимок автоматически', type: 'checkbox', value: s.autoSync },
                  { name: 'intervalSeconds', label: 'Интервал обновления, сек.', type: 'number', value: s.intervalSeconds || 120 },
                  ...(s.hasApiKey ? [{ name: 'clearApiKey', label: 'Удалить сохранённый ключ', type: 'checkbox' }] : []),
                ],
                values => call('corporateConfigure', values),
                { hint: 'Сервер ' + s.baseUrl + '. Для проверки нужен доступ к корпоративной сети.' },
              )}>Настроить подключение</button>
              <Action id="corporate-check" disabled={!s.hasApiKey} onClick={async () =>
                app.detail('Подключение к n8n', await call('corporateCheck'))
              }>Проверить API</Action>
              <Action onClick={() => api.openCorporateN8n()}>Открыть n8n ↗</Action>
              <Action
                id="corporate-sync"
                className="primary"
                disabled={!s.hasApiKey || s.syncing}
                onClick={async () => {
                  try {
                    await call('corporateSync');
                  } finally {
                    app.refresh();
                  }
                }}
              >
                {s.syncing ? 'Загружаем…' : 'Загрузить данные'}
              </Action>
              <Action
                id="corporate-history"
                onClick={async () =>
                  app.detail('Корпоративные запуски', await call('corporateExecutions'))
                }
              >
                История запусков
              </Action>
            </div>
            <p>
              {s.hasApiKey
                ? 'Чтение через API в корпоративной сети. Снимок доступен без сети.'
                : 'Для загрузки с n8n.t-tech.team нужны корпоративная сеть и API-ключ с правами чтения. Укажите ключ в настройках подключения.'}
            </p>
            {s.lastError && <p className="warning">{s.lastError}</p>}
            <p className="source">
              Последняя загрузка: {date(s.lastSyncedAt)} ·{' '}
              {s.stale ? 'Требует обновления' : 'Актуальный снимок'}
            </p>
          </Panel>
          <Panel title="Корпоративные процессы">
            <input
              id="corporate-query"
              placeholder="Поиск процесса по имени"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {snapshot.data
              .filter((w: Row) => w.name.toLowerCase().includes(query.toLowerCase()))
              .map((w: Row) => (
                <div className="item" key={w.id}>
                  <h3>
                    {w.name} <span className="tag">{w.active ? 'Активен' : 'Неактивен'}</span>
                  </h3>
                  <p className="source">
                    ID {w.id} · {date(w.updatedAt)}
                  </p>
                  <Action
                    data-corporate-flow={w.id}
                    onClick={async () => setWorkflow(await call('corporateWorkflow', { id: w.id }))}
                  >
                    Посмотреть схему
                  </Action>
                </div>
              ))}
            {!snapshot.data.length && <Empty title="Нет сохранённого снимка" />}
          </Panel>
          {workflow && <Workflow key={workflow.id} workflow={workflow} />}
        </>
      )}
    </Load>
  );
}
