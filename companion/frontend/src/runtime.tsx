import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './components/primitives';
export type Row = Record<string, any>;
export type Field = {
  name: string;
  label: string;
  type?: string;
  value?: any;
  options?: any[];
  required?: boolean;
  max?: number;
  rows?: number;
  wide?: boolean;
  group?: string;
  hint?: string;
  readOnly?: boolean;
};
export const api = (window as any).companion;
export const call = (mode: string, input: Row = {}) => api.call(mode, input) as Promise<any>;
export const date = (value: any) =>
  value ? new Date(value).toLocaleString('ru-RU') : 'ещё не создан';
export const lines = (v: any) =>
  String(v || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
export const csv = (v: any) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
export const short = (v: any, n = 200) =>
  String(v || '').length > n ? String(v).slice(0, n) + '…' : String(v || '');
export const priorities = { low: 'Низкий', normal: 'Обычный', high: 'Высокий', urgent: 'Срочный' };
const statusNames: Row = {
  planned: 'Запланировано',
  running: 'Выполняется',
  completed: 'Отчёт получен',
  failed: 'Ошибка',
  blocked: 'Заблокировано',
  'observed-running': 'Запуск зарегистрирован',
  'observed-stopped': 'Остановка зарегистрирована',
  pending: 'На проверке',
  approved: 'Подтверждено',
  rejected: 'Отклонено',
  merged: 'Объединено',
  accepted: 'Принято',
  proposed: 'Предложено',
  superseded: 'Заменено',
  ready: 'MCP отвечает',
  unverified: 'Не проверен',
  disabled: 'Выключен',
  missing: 'Нет команды',
  installed: 'Файлы установлены',
  review: 'Результат на проверке',
  queued: 'Ожидает подтверждения',
  cancelled: 'Отменено',
  interrupted: 'Прервано',
};
export function Status({ value }: { value: string }) {
  return <span className={`tag status-${value}`}>{statusNames[value] || value}</span>;
}
export function Empty({
  title = 'Пока нет записей',
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="workspace-empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function Panel({
  title,
  children,
  actions,
}: {
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="panel">
      {title && (
        <div className="section-head">
          <h2>{title}</h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
export function Json({ value }: { value: any }) {
  return (
    <pre className="oc-json">
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
export type EditorOptions = {
  hint?: string;
  submit?: string;
  after?: () => any;
  actions?: ReactNode;
};
type Modal = { title: string; body: ReactNode };
type Runtime = {
  page: string;
  tab: string;
  go: (page: string, tab?: string) => void;
  refresh: () => void;
  revision: number;
  catalogs: any;
  collection: string;
  project: string;
  setScope: (collection: string, project: string) => void;
  scope: Row;
  preferences: Row;
  setPreferences: (p: Row) => void;
  run: (f: () => any) => Promise<any>;
  detail: (title: string, value: any) => void;
  modal: (title: string, body: ReactNode) => void;
  close: () => void;
  edit: (title: string, fields: Field[], save: (v: Row) => any, options?: EditorOptions) => void;
};
export const RuntimeContext = createContext<Runtime>(null!);
export const useApp = () => useContext(RuntimeContext);
export function useLoad(loader: () => Promise<any>, deps: any[] = []) {
  const { revision } = useApp();
  const [state, set] = useState<{ data: any; error: string; loading: boolean }>({
    data: null,
    error: '',
    loading: true,
  });
  useEffect(() => {
    let current = true;
    set((s) => ({ ...s, error: '', loading: true }));
    Promise.resolve()
      .then(loader)
      .then(
        (data) => {
          if (current) set({ data, error: '', loading: false });
        },
        (e) => {
          if (current) set({ data: null, error: e.message || String(e), loading: false });
        },
      );
    return () => {
      current = false;
    };
  }, [revision, ...deps]);
  return state;
}
export function Load({
  state,
  children,
}: {
  state: ReturnType<typeof useLoad>;
  children: (data: any) => ReactNode;
}) {
  const app = useApp();
  if (state.error)
    return (
      <Panel>
        <p role="alert">{state.error}</p>
        <Button onClick={app.refresh}>Повторить</Button>
      </Panel>
    );
  if (state.data === null)
    return (
      <div className="knowledge-loading" role="status">
        <span className="spinner" />
        Загружаем…
      </div>
    );
  return <div aria-busy={state.loading}>{children(state.data)}</div>;
}
export function Action({
  onClick,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'onClick'> & { onClick: () => any }) {
  const app = useApp();
  const [busy, set] = useState(false);
  const pending = useRef(false);
  return (
    <Button
      {...props}
      disabled={props.disabled || busy}
      onClick={() => {
        if (pending.current) return;
        pending.current = true;
        set(true);
        void app.run(onClick).finally(() => {
          pending.current = false;
          set(false);
        });
      }}
    >
      {children}
    </Button>
  );
}
export function FormEditor({
  fields,
  save,
  options = {},
}: {
  fields: Field[];
  save: (v: Row) => any;
  options?: EditorOptions;
}) {
  const app = useApp();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const groups = [...new Set(fields.map((f) => f.group).filter(Boolean))];
  const control = (f: Field) => (
    <label key={f.name} className={`editor-field ${f.wide ? 'wide' : ''}`}>
      {f.label}
      {f.type === 'textarea' ? (
        <textarea
          id={'field-' + f.name}
          name={f.name}
          defaultValue={f.value ?? ''}
          rows={f.rows || 4}
          maxLength={f.max || 24000}
          required={f.required}
        />
      ) : f.type === 'select' || f.type === 'multi' ? (
        <select
          id={'field-' + f.name}
          name={f.name}
          defaultValue={f.value ?? (f.type === 'multi' ? [] : '')}
          multiple={f.type === 'multi'}
          size={f.type === 'multi' ? 5 : undefined}
          required={f.required}
        >
          {(f.options || []).map((o: any) => {
            const [v, t] = Array.isArray(o) ? o : [o, o];
            return (
              <option key={v} value={v}>
                {t}
              </option>
            );
          })}
        </select>
      ) : (
        <input
          id={'field-' + f.name}
          name={f.name}
          type={f.type || 'text'}
          defaultValue={f.type === 'checkbox' ? undefined : (f.value ?? '')}
          defaultChecked={f.type === 'checkbox' ? !!f.value : undefined}
          required={f.required}
          maxLength={f.max || 1000}
          readOnly={f.readOnly}
        />
      )}
      {f.hint && <small>{f.hint}</small>}
    </label>
  );
  return (
    <>
      {options.hint && <p className="muted">{options.hint}</p>}
      <form
        id="workspace-editor"
        ref={form}
        onInvalidCapture={(e) => {
          const section = (e.target as Element).closest('details');
          if (section) section.open = true;
        }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          const fd = new FormData(e.currentTarget);
          const values = Object.fromEntries(
            fields.map((f) => [
              f.name,
              f.type === 'checkbox'
                ? fd.has(f.name)
                : f.type === 'multi'
                  ? fd.getAll(f.name)
                  : fd.get(f.name),
            ]),
          );
          try {
            await save(values);
            app.close();
            await (options.after || app.refresh)();
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="editor-fields">
          {fields.filter((f) => !f.group).map(control)}
          {groups.map((g) => (
            <details className="editor-section" key={g}>
              <summary>{g}</summary>
              <div className="editor-fields">
                {fields.filter((f) => f.group === g).map(control)}
              </div>
            </details>
          ))}
        </div>
        <p id="editor-error" className="warning" role="alert">
          {error}
        </p>
        <div className="toolbar">
          <Button type="submit" className="primary" disabled={busy}>
            {options.submit || 'Сохранить'}
          </Button>
          <Button onClick={app.close} disabled={busy}>
            Отмена
          </Button>
          {options.actions}
        </div>
      </form>
    </>
  );
}
export function ModalView({
  value,
  close,
  error,
}: {
  value: Modal | null;
  close: () => void;
  error: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (value && !ref.current?.open) ref.current?.showModal();
    if (!value && ref.current?.open) ref.current.close();
  }, [value]);
  return (
    <dialog id="detail" ref={ref} onCancel={close} onClose={close}>
      <Button id="close-detail" onClick={close}>
        Закрыть
      </Button>
      <h2 id="detail-title">{value?.title}</h2>
      <p role="alert" hidden={!error}>
        {error}
      </p>
      <div id="detail-body">{value?.body}</div>
    </dialog>
  );
}
export function useRuntime() {
  const [page, setPage] = useState('overview'),
    [tabs, setTabs] = useState<Row>({
      overview: 'today',
      knowledge: 'graph',
      rag: 'search',
      mcp: 'installed',
      agents: 'definitions',
    }),
    [revision, setRevision] = useState(0),
    [catalogs, setCatalogs] = useState<any>({ collections: [], projects: [] }),
    [collection, setCollection] = useState('odysseus'),
    [project, setProject] = useState(''),
    [preferences, setPreferences] = useState<Row>({}),
    [modal, setModal] = useState<Modal | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(0);
  const refresh = () => setRevision((v) => v + 1),
    close = () => setModal(null);
  useEffect(() => {
    let current = true;
    call('catalogs')
      .then((c) => {
        if (!current) return;
        setCatalogs(c);
        if (!c.collections.some((x: Row) => x.id === collection)) {
          setCollection(c.collections[0]?.id || 'projects');
          setProject('');
        } else if (
          project &&
          !c.projects.some((x: Row) => x.id === project && x.collection === collection)
        )
          setProject('');
      })
      .catch((e) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [revision, collection, project]);
  const run = async (f: () => any) => {
    setBusy((n) => n + 1);
    setError('');
    try {
      return await f();
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setBusy((n) => n - 1);
    }
  };
  const value: Runtime = {
    page,
    tab: tabs[page] || '',
    go: (p, t) => {
      setPage(p);
      refresh();
      if (t) setTabs((v) => ({ ...v, [p]: t }));
      setError('');
    },
    revision,
    refresh,
    catalogs,
    collection,
    project,
    setScope: (c, p) => {
      setCollection(c);
      setProject(p);
    },
    scope: { collection, ...(project ? { project } : {}) },
    preferences,
    setPreferences,
    run,
    detail: (title, v) => setModal({ title, body: <Json value={v} /> }),
    modal: (title, body) => setModal({ title, body }),
    close,
    edit: (title, fields, save, options) =>
      setModal({
        title,
        body: (
          <FormEditor key={crypto.randomUUID()} fields={fields} save={save} options={options} />
        ),
      }),
  };
  return { value, modal, error, busy };
}
export function projectOptions(app: Runtime) {
  return [
    ['', 'Без проекта'],
    ...app.catalogs.projects.map((p: Row) => [p.id.replace(/^project:/, ''), p.name]),
  ];
}
export function nessyBuilder(
  app: Runtime,
  builder: string,
  targetId?: string,
  description = '',
  scope: Row = {},
) {
  app.edit(
    (targetId ? 'Изменить' : 'Создать') +
      (builder === 'agent'
        ? ' субагента'
        : builder === 'knowledge'
          ? ' знания'
          : builder === 'tools'
            ? ' набор инструментов'
            : ' сценарий') +
      ' с Nessy',
    [
      {
        name: 'description',
        label: 'Что вы хотите сделать?',
        type: 'textarea',
        required: true,
        wide: true,
        max: 12000,
        value: description,
      },
    ],
    async (v) => {
      const r = await api.runScenario({
        assistant: true,
        builder,
        targetId,
        ...scope,
        description: v.description,
      });
      if (r.cancelled) throw Error('Запуск отменён');
    },
    {
      submit: 'Продолжить в Nessy ↗',
      hint: 'Nessy уточнит детали и сохранит результат через инструменты Companion.',
    },
  );
}
