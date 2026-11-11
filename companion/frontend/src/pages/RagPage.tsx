import { useRef, useState } from 'react';
import { Button, ScopeFields, type ScopeProps } from '../components/primitives';
import { SpotlightSurface } from '../components/SpotlightSurface';

type Match = { title: string; text: string; source: string; nodeId: string; score: number };
type Retrieval = { matches: Match[]; mode: string; indexedAt?: string; auditId?: string };
type Index = {
  id: string;
  collection?: string;
  chunks: number;
  updatedAt?: string;
  embeddingModel?: string;
  sources: string[];
};
export type RagProps = Omit<ScopeProps, 'actions'> & {
  indexes: Index[];
  call: (mode: string, input?: object) => Promise<any>;
  run: (action: () => Promise<void>) => Promise<unknown>;
  showDetail: (title: string, result: unknown) => void;
  refresh: () => Promise<void>;
  addProject: () => Promise<void>;
  askNessy: (query: string) => void;
};
const date = (value?: string) =>
  value ? new Date(value).toLocaleString('ru-RU') : 'ещё не создан';

export function RagPage(props: RagProps) {
  const { indexes, call, run, showDetail, refresh, addProject, askNessy } = props;
  const input = useRef<HTMLInputElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<Retrieval | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const scope = {
    collection: props.collection,
    ...(props.project ? { project: props.project } : {}),
  };
  const perform = (label: string, action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(label);
    setError('');
    void run(async () => {
      try {
        await action();
      } catch (e) {
        if (host.current?.isConnected) setError(e instanceof Error ? e.message : String(e));
      } finally {
        pending.current = false;
        if (host.current?.isConnected) setBusy('');
      }
    });
  };
  const search = (mode: 'search' | 'answer') => {
    const query = input.current?.value.trim();
    if (!query) {
      input.current?.focus();
      return;
    }
    perform(
      mode === 'answer' ? 'Готовим ответ по найденным источникам…' : 'Ищем в локальных знаниях…',
      async () => {
        const response = await call(mode, { ...scope, query });
        if (!host.current?.isConnected) return;
        setAnswer(mode === 'answer' ? response.answer : null);
        setResult(mode === 'answer' ? response.retrieval : response);
        setExcluded(new Set());
      },
    );
  };
  return (
    <div ref={host} className="oc-rag-page" data-react-page="rag">
      <div className="oc-scope-bar knowledge-scope" aria-label="Область поиска">
        <ScopeFields
          {...props}
          disabled={!!busy}
          actions={
            <>
              <Button
                id="index-rag"
                disabled={!!busy}
                onClick={() =>
                  perform('Обновляем индекс…', async () => {
                    const response = await call('index', scope);
                    if (!host.current?.isConnected) return;
                    showDetail('RAG-индекс обновлён', response);
                    await refresh();
                  })
                }
              >
                Обновить RAG-индекс
              </Button>
              <Button
                id="rag-add-project"
                disabled={!!busy}
                onClick={() => perform('Добавляем проект…', addProject)}
              >
                Добавить проект
              </Button>
            </>
          }
        />
      </div>
      <SpotlightSurface className="panel oc-search-studio">
        <div className="oc-search-heading">
          <span className="oc-search-mark" aria-hidden="true">
            ⌕
          </span>
          <span className="eyebrow">ЛОКАЛЬНАЯ ПАМЯТЬ</span>
        </div>
        <h2>Найдите то, что уже знаете</h2>
        <p className="muted">Документы, код и принятые решения — с источниками для проверки.</p>
        <form
          className="oc-search-form"
          onSubmit={(e) => {
            e.preventDefault();
            search('search');
          }}
        >
          <label className="sr-only" htmlFor="rag-query">
            Что найти в документах и коде
          </label>
          <input
            ref={input}
            id="rag-query"
            placeholder="Что нужно найти в документах и коде?"
            autoComplete="off"
          />
          <div className="oc-search-actions">
            <Button id="rag-search" type="submit" className="primary" disabled={!!busy}>
              Найти источники
            </Button>
            <Button id="rag-answer" disabled={!!busy} onClick={() => search('answer')}>
              Ответ по источникам
            </Button>
          </div>
        </form>
        <div className="search-prompts">
          {['Архитектура проекта', 'Последние решения', 'Как устроен импорт'].map((q) => (
            <Button
              key={q}
              data-search-prompt={q}
              onClick={() => {
                if (input.current) {
                  input.current.value = q;
                  input.current.focus();
                }
              }}
            >
              {q}
              <span aria-hidden="true">↗</span>
            </Button>
          ))}
        </div>
        <p className="oc-search-note">
          Поиск работает без дополнительной модели. Ответ по источникам использует выбранное
          подключение. Embeddings включают семантический поиск.
        </p>
      </SpotlightSurface>
      <div className="knowledge-ai-strip">
        <div>
          <strong>Спросите свою базу знаний</strong>
          <p>Найти ответ, объяснить связи или сохранить новую информацию.</p>
        </div>
        <Button
          className="primary"
          id="knowledge-nessy-rag"
          onClick={() => askNessy(input.current?.value || '')}
        >
          Спросить Nessy ↗
        </Button>
      </div>
      <div id="rag-result" aria-live="polite" aria-busy={!!busy}>
        {busy && (
          <div className="knowledge-loading" role="status">
            <span className="spinner" />
            {busy}
          </div>
        )}
        {error && (
          <div className="oc-inline-error" role="alert">
            {error}
            <p>Попробуйте ещё раз или проверьте выбранный каталог.</p>
          </div>
        )}
        {answer !== null && (
          <section className="panel">
            <h2>Ответ</h2>
            <div className="answer">{answer}</div>
          </section>
        )}
        {result &&
          (!result.matches.length ? (
            <div className="knowledge-empty">
              <h3>По этому запросу ничего не найдено</h3>
              <p>
                Уточните формулировку, проверьте выбранный каталог или добавьте документы проекта.
              </p>
            </div>
          ) : (
            <>
              <p className="muted">
                Режим: {result.mode} · индекс: {date(result.indexedAt)} · найдено:{' '}
                {result.matches.length}
              </p>
              {result.matches.map((match, index) => (
                <article
                  className="result"
                  key={`${match.nodeId}:${index}`}
                  data-audit={result.auditId || ''}
                >
                  <div className="item-title">
                    {index + 1}. {match.title}
                    <span className="tag">Источник {index + 1}</span>
                  </div>
                  <p className="answer">
                    {match.text.length > 650 ? match.text.slice(0, 650) + '…' : match.text}
                  </p>
                  <details>
                    <summary>Фрагмент и происхождение</summary>
                    <p className="answer">{match.text}</p>
                    <div className="source">
                      {match.source} · {match.nodeId} · оценка {Number(match.score).toFixed(3)}
                    </div>
                  </details>
                  <Button
                    data-exclude-result={index}
                    disabled={!!busy || excluded.has(index)}
                    onClick={() =>
                      perform('Исключаем источник…', async () => {
                        await call('sourceExclusion', {
                          action: 'add',
                          source: match.source,
                          nodeId: match.nodeId,
                          ...scope,
                        });
                        if (host.current?.isConnected)
                          setExcluded((previous) => new Set([...previous, index]));
                      })
                    }
                  >
                    {excluded.has(index) ? 'Источник исключён' : 'Исключить источник из поиска'}
                  </Button>
                </article>
              ))}
            </>
          ))}
      </div>
      <details className="utility-drawer rag-indexes">
        <summary>Состояние индексов и документов</summary>
        {indexes.length ? (
          indexes.map((i) => (
            <details key={i.collection || i.id}>
              <summary>
                {i.collection || i.id} · {i.chunks} фрагментов · {date(i.updatedAt)}
              </summary>
              <p className="muted">
                {i.embeddingModel ? 'Семантический + текстовый' : 'Текстовый + граф'}
              </p>
              <pre>{i.sources.join('\n')}</pre>
            </details>
          ))
        ) : (
          <p className="empty">Индекс появится после первого поиска или обновления.</p>
        )}
      </details>
    </div>
  );
}
