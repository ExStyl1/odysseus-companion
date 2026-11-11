import { useState } from 'react';
import { Button } from '../components/primitives';
import { call, csv, Load, Panel, useApp, useLoad, type Row } from '../runtime';
export function ToolIcons() {
  const app = useApp(),
    state = useLoad(() => call('toolIcons')),
    [query, setQuery] = useState('');
  return (
    <Load state={state}>
      {(data) => (
        <Panel
          title="Иконки инструментов"
          actions={
            <Button
              id="add-tool-icon"
              onClick={() => app.modal('Новый инструмент', <IconEditor />)}
            >
              Добавить инструмент
            </Button>
          }
        >
          <p>Рядом с CLI-командами в активности чата.</p>
          <input
            id="tool-icon-query"
            placeholder="Найти Git, Python, Docker…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className="source">
            {data.directory} · {data.tools.length} инструментов
          </p>
          <div className="tool-icon-grid">
            {data.tools
              .filter((t: Row) =>
                (t.displayName + ' ' + t.commands.join(' '))
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((t: Row) => (
                <Button
                  key={t.id}
                  className="tool-icon-card"
                  data-tool-icon={t.id}
                  onClick={() => app.modal('Иконка: ' + t.displayName, <IconEditor tool={t} />)}
                >
                  {t.image ? <img src={t.image} alt="" /> : <span>⌘</span>}
                  <strong>{t.displayName}</strong>
                  <span className="source">{t.commands.join(', ')}</span>
                </Button>
              ))}
          </div>
        </Panel>
      )}
    </Load>
  );
}
function IconEditor({ tool: t }: { tool?: Row }) {
  const app = useApp(),
    [data, setData] = useState<string>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [reading, setReading] = useState(false);
  return (
    <form
      id="tool-icon-form"
      className="icon-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || reading) return;
        const fields = Object.fromEntries(new FormData(e.currentTarget));
        setBusy(true);
        setError('');
        try {
          await call('toolIconSave', {
            id: fields.id,
            displayName: fields.displayName,
            commands: csv(fields.commands),
            data,
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
      <div className="icon-preview">
        {(data || t?.image) && <img src={data || t?.image} alt="Предпросмотр" />}
      </div>
      <label>
        ID
        <input
          name="id"
          required
          pattern="[a-z0-9][a-z0-9-]{0,70}"
          defaultValue={t?.id}
          readOnly={!!t}
        />
      </label>
      <label>
        Название
        <input name="displayName" required maxLength={100} defaultValue={t?.displayName} />
      </label>
      <label>
        CLI-команды, через запятую
        <input name="commands" required defaultValue={t?.commands.join(', ')} />
      </label>
      <label>
        Изображение
        <input
          type="file"
          accept="image/png,image/jpeg,.ico"
          onChange={async (e) => {
            setError('');
            const file = e.target.files?.[0];
            setData(undefined);
            if (!file) return;
            if (file.size > 512000) {
              setError('Файл должен быть меньше 500 КБ');
              e.target.value = '';
              return;
            }
            setReading(true);
            try {
              const result = await new Promise<string>((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(String(r.result));
                r.onerror = () => reject(Error('Не удалось прочитать файл'));
                r.readAsDataURL(file);
              });
              setData(result.replace('data:image/vnd.microsoft.icon;', 'data:image/x-icon;'));
            } catch (e: any) {
              setError(e.message);
            } finally {
              setReading(false);
            }
          }}
        />
      </label>
      <p className="source">
        PNG, JPG или ICO до 500 КБ. Перезапустите Nessy, чтобы обновить иконки в нём.
      </p>
      <p role="alert">{error}</p>
      <Button className="primary" type="submit" disabled={busy || reading}>
        Сохранить иконку
      </Button>
    </form>
  );
}
