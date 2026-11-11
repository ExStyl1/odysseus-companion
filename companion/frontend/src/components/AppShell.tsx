import { Fragment, type ReactNode } from 'react';
import { Action, api, useApp } from '../runtime';

const navIcons: Record<string, ReactNode> = {
  learning: <path d="M12 5v15m0-15C8 3 5 3 2 4v15c3-1 6-1 10 1 4-2 7-2 10-1V4c-3-1-6-1-10 1Z" />,
  overview: <path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-6v-7H10v7H4a1 1 0 0 1-1-1Z" />,
  knowledge: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="4" cy="5" r="2" />
      <circle cx="20" cy="5" r="2" />
      <circle cx="5" cy="20" r="2" />
      <circle cx="20" cy="19" r="2" />
      <path d="m6 6 4 4m4 0 4-4m-8 8-4 4m8-4 4 3" />
    </>
  ),
  rag: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  n8n: <path d="m13 2-9 12h7l-1 8 10-13h-7Z" />,
  skills: <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" />,
  mcp: <path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0Zm6 9v5" />,
  agents: (
    <>
      <circle cx="9" cy="7" r="3" />
      <path d="M3 20v-2a6 6 0 0 1 12 0v2m2-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 2 4v2" />
    </>
  ),
  updates: <path d="M20 11a8 8 0 0 0-14-5L3 9m0-5v5h5m-4 4a8 8 0 0 0 14 5l3-3m0 5v-5h-5" />,
  appearance: (
    <>
      <circle cx="8" cy="8" r=".8" />
      <circle cx="13" cy="6" r=".8" />
      <circle cx="17" cy="10" r=".8" />
      <path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 2-2c0-1-1-1.5-1-2.5a1.5 1.5 0 0 1 1.5-1.5H18a3 3 0 0 0 3-3 9 9 0 0 0-9-9Z" />
    </>
  ),
};
const sections: Record<string, string> = {
  overview: 'РАБОТА',
  knowledge: 'ЗНАНИЯ',
  n8n: 'ИНСТРУМЕНТЫ',
};

export function AppShell({
  pages,
  heading,
  error,
  busy,
  children,
}: {
  pages: Record<string, string>;
  heading: ReactNode;
  error: string;
  busy: number;
  children: ReactNode;
}) {
  const app = useApp();
  return (
    <>
      <div className="window-drag" />
      <aside aria-label="Боковая панель">
        <div className="brand">
          <img className="mark" src="assets/odysseus-mark.png" alt="Шлем Odysseus" />
          <div>
            ODYSSEUS<small>COMPANION</small>
          </div>
        </div>
        <div className="aside-label">РАБОЧАЯ ПЛАТФОРМА</div>
        <nav id="nav" aria-label="Разделы Companion">
          <Navigation pages={pages} current={app.page} choose={app.go} />
        </nav>
        <div className="aside-bottom">
          <span className="live" />
          Локальное пространство
          <br />
          <Action id="open-nessy" onClick={() => api.openNessy()}>
            Открыть Nessy ↗
          </Action>
        </div>
      </aside>
      <main>
        <header className="window-toolbar">
          <div className="breadcrumb">
            <span>Личное пространство</span>
            <span className="crumb-divider">/</span>
            <h1 id="title">{pages[app.page]}</h1>
          </div>
          <div className="header-actions">
            <button
              onClick={app.refresh}
              id="refresh"
              className="icon-button"
              title="Обновить данные"
              aria-label="Обновить данные"
            >
              ↻
            </button>
            <span className="toolbar-divider" />
            <Action id="profile" className="profile-button" onClick={() => api.showProfile()}>
              <span className="profile-avatar">N</span>Профиль Nessy
            </Action>
          </div>
        </header>
        <div className="page-scroll">
          <div className="page-container">
            <div id="page-heading" className="page-heading">
              {heading}
            </div>
            <div id="error" role="alert" hidden={!error}>
              {error}
            </div>
            <div id="busy" hidden={!busy}>
              <span className="spinner" />
              Обновляем пространство…
            </div>
            <section id="content" aria-live="polite">
              {children}
            </section>
            <footer className="page-footer">
              <span>Odysseus Companion</span>
              <span>Знания остаются с вами</span>
            </footer>
          </div>
        </div>
      </main>
    </>
  );
}

export function Navigation({
  pages,
  current,
  choose,
}: {
  pages: Record<string, string>;
  current: string;
  choose: (page: string) => void;
}) {
  return (
    <>
      {Object.entries(pages).map(([id, title]) => (
        <Fragment key={id}>
          {sections[id] && <div className="nav-section-label">{sections[id]}</div>}
          <button
            data-page={id}
            className={current === id ? 'active' : ''}
            aria-current={current === id ? 'page' : undefined}
            onClick={() => choose(id)}
          >
            <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
              {navIcons[id]}
            </svg>
            <span>{title}</span>
          </button>
        </Fragment>
      ))}
    </>
  );
}
