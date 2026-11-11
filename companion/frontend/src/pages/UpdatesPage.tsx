import { useEffect, useState } from 'react';
import { api } from '../runtime';

type UpdateResult = {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
};

export function UpdatesPage() {
  const [version, setVersion] = useState('');
  const [result, setResult] = useState<UpdateResult>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void api.version().then(
      (value: string) => { if (active) setVersion(value); },
      () => { if (active) setError('Не удалось определить установленную версию.'); },
    );
    return () => { active = false; };
  }, []);

  async function check() {
    setChecking(true);
    setError('');
    setResult(undefined);
    try {
      const update: UpdateResult = await api.checkUpdate();
      setVersion(update.currentVersion);
      setResult(update);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось проверить обновления.');
    } finally {
      setChecking(false);
    }
  }

  async function openRelease() {
    try {
      await api.openRelease(result?.latestVersion);
    } catch {
      setError('Не удалось открыть страницу релиза.');
    }
  }

  return (
    <section className="panel" aria-busy={checking}>
      <h2>Odysseus Companion</h2>
      {version && <p>Установленная версия: {version}</p>}
      <p role="status">
        {checking ? 'Проверяем релизы на GitHub…' : result
          ? result.available ? `Доступна версия ${result.latestVersion}.` : 'Новых версий нет.'
          : 'Обновления публикуются на GitHub.'}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="toolbar">
        <button type="button" className="primary" disabled={checking} onClick={() => void check()}>
          Проверить обновления
        </button>
        {(result?.available || error) && (
          <button type="button" onClick={() => void openRelease()}>{result?.available ? 'Открыть релиз ↗' : 'Открыть релизы ↗'}</button>
        )}
      </div>
    </section>
  );
}
