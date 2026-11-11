import { Component, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from './components/AppShell';
import { PageHeading, Tabs } from './components/primitives';
import {
  api,
  call,
  ModalView,
  RuntimeContext,
  useRuntime,
  useApp,
  useLoad,
  Load,
  nessyBuilder,
} from './runtime';
import { TodayPage, BoardPage, ChatsPage } from './pages/PersonalPages';
import { ScenariosPage, QueuePage, AgentsPage } from './pages/ScenarioPages';
import {
  KnowledgeGraph,
  SourcesPage,
  PassportsPage,
  InboxPage,
  QualityPage,
  DecisionsPage,
  RetrievalHistory,
} from './pages/KnowledgePages';
import {
  SkillsPage,
  InstalledTools,
  SystemsPage,
  TaskPicker,
  ProfilesPage,
  DiagnosticsPage,
} from './pages/ToolsPages';
import { AutomationPage } from './pages/AutomationPage';
import { RagPage } from './pages/RagPage';
import { AppearancePage } from './pages/AppearancePage';
import { Learning } from './pages/LearningPage';
import { ToolIcons } from './pages/ToolIcons';
import { themes, useAppearance, useSpotlight } from './theme';
import './ui.css';
const pages = {
  overview: 'Обзор',
  learning: 'Обучение',
  knowledge: 'Граф знаний',
  rag: 'RAG и источники',
  n8n: 'Автоматизации n8n',
  skills: 'Навыки',
  mcp: 'MCP и плагины',
  agents: 'Субагенты',
  appearance: 'Оформление',
};
const tabs: Record<string, [string, string][]> = {
  overview: [
    ['today', 'Сегодня'],
    ['scenarios', 'Сценарии'],
    ['chats', 'Чаты'],
    ['board', 'Доска'],
    ['queue', 'В фоне'],
  ],
  knowledge: [
    ['graph', 'Граф знаний'],
    ['passports', 'Паспорта проектов'],
    ['sources', 'Источники'],
    ['inbox', 'Входящие знания'],
    ['decisions', 'Решения'],
    ['quality', 'Качество памяти'],
  ],
  rag: [
    ['search', 'Поиск по знаниям'],
    ['history', 'Контекст перед ответом'],
    ['excluded', 'Исключённые источники'],
  ],
  mcp: [
    ['installed', 'Установленные инструменты'],
    ['systems', 'По системам'],
    ['task', 'Подбор для задачи'],
    ['profiles', 'Рабочие профили'],
    ['diagnostics', 'Состояние системы'],
  ],
  agents: [
    ['definitions', 'Роли и права'],
    ['runs', 'Этапы и запуски'],
  ],
};
const headings: Record<string, [string, string]> = {
  overview: ['Ваш день с Nessy', 'Задачи, знания и рабочий ритм — в одном месте.'],
  scenarios: ['Рабочие сценарии', 'Готовые помощники с выбранными навыками и MCP.'],
  chats: ['История чатов', 'Найдите разговор и продолжите с нужного места.'],
  board: ['Мои задачи', 'Личная доска для планов и приоритетов.'],
  queue: ['Фоновые задачи', 'Следите за выполнением и возвращайтесь к результатам.'],
  knowledge: ['Граф знаний', 'Исследуйте связи между проектами, документами и решениями.'],
  rag: ['Поиск по вашим знаниям', 'Ответы начинаются с надёжных источников.'],
  n8n: ['Корпоративный n8n', 'Процессы, схемы и история запусков.'],
  skills: ['Библиотека навыков', 'Инструкции для ваших рабочих задач.'],
  mcp: ['MCP и плагины', 'Инструменты, которые расширяют возможности Nessy.'],
  agents: ['Команда субагентов', 'От исследования до проверки — у каждого этапа своя роль.'],
  appearance: ['Ваше пространство', 'Настройте оформление под свой рабочий ритм.'],
  learning: ['Как работать с Companion', 'Выберите урок и попробуйте действие в приложении.'],
};
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  render() {
    return this.state.error ? (
      <section className="panel">
        <h2>Не удалось показать раздел</h2>
        <p role="alert">{this.state.error}</p>
        <button onClick={() => this.setState({ error: '' })}>Повторить</button>
      </section>
    ) : (
      this.props.children
    );
  }
}
function Rag() {
  const app = useApp(),
    state = useLoad(() => call('rag'));
  return (
    <Load state={state}>
      {(indexes) => (
        <RagPage
          key={app.collection + ':' + app.project}
          indexes={indexes}
          catalogs={app.catalogs}
          collection={app.collection}
          project={app.project}
          onCollection={(c) => app.setScope(c, '')}
          onProject={(p) => app.setScope(app.collection, p)}
          call={call}
          run={app.run}
          showDetail={app.detail}
          refresh={async () => app.refresh()}
          addProject={async () => {
            const path = await api.chooseFolder();
            if (path) {
              await call('registerProject', { path });
              app.refresh();
            }
          }}
          askNessy={(query) =>
            nessyBuilder(
              app,
              'knowledge',
              undefined,
              query || 'Помоги найти ответы в моих знаниях.',
              app.scope,
            )
          }
        />
      )}
    </Load>
  );
}
function Appearance() {
  const app = useApp(),
    state = useLoad(() => call('personal'));
  return (
    <Load state={state}>
      {(preferences) => (
        <>
          <AppearancePage
            preferences={preferences}
            themes={themes}
            run={app.run}
            save={(patch) => call('personalUpdate', patch)}
            apply={app.setPreferences}
          />
          <ToolIcons />
        </>
      )}
    </Load>
  );
}
function Route() {
  const a = useApp();
  switch (a.page) {
    case 'overview':
      return a.tab === 'scenarios' ? (
        <ScenariosPage />
      ) : a.tab === 'queue' ? (
        <QueuePage />
      ) : a.tab === 'chats' ? (
        <ChatsPage />
      ) : a.tab === 'board' ? (
        <BoardPage />
      ) : (
        <TodayPage />
      );
    case 'knowledge':
      return a.tab === 'sources' ? (
        <SourcesPage />
      ) : a.tab === 'passports' ? (
        <PassportsPage />
      ) : a.tab === 'inbox' ? (
        <InboxPage />
      ) : a.tab === 'decisions' ? (
        <DecisionsPage />
      ) : a.tab === 'quality' ? (
        <QualityPage />
      ) : (
        <KnowledgeGraph key={a.collection + ':' + a.project} />
      );
    case 'rag':
      return a.tab === 'search' ? <Rag /> : <RetrievalHistory />;
    case 'mcp':
      return a.tab === 'systems' ? (
        <SystemsPage />
      ) : a.tab === 'task' ? (
        <TaskPicker />
      ) : a.tab === 'profiles' ? (
        <ProfilesPage />
      ) : a.tab === 'diagnostics' ? (
        <DiagnosticsPage />
      ) : (
        <InstalledTools />
      );
    case 'skills':
      return <SkillsPage />;
    case 'agents':
      return <AgentsPage />;
    case 'n8n':
      return <AutomationPage />;
    case 'appearance':
      return <Appearance />;
    default:
      return null;
  }
}
function App() {
  const runtime = useRuntime(),
    app = runtime.value;
  useAppearance(app.preferences);
  useSpotlight();
  useEffect(() => {
    void app.run(async () => app.setPreferences(await call('personal')));
  }, []);
  useEffect(() => {
    const focus = () => {
      if (
        !runtime.modal &&
        !runtime.busy &&
        ['overview', 'knowledge', 'agents', 'rag'].includes(app.page)
      )
        app.refresh();
    };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [app.page, runtime.modal, runtime.busy]);
  const [title, subtitle] =
    headings[app.page === 'overview' && app.tab !== 'today' ? app.tab : app.page] ||
    headings.overview;
  return (
    <RuntimeContext.Provider value={app}>
      <AppShell
        pages={pages}
        heading={<PageHeading title={title} subtitle={subtitle} />}
        error={runtime.error}
        busy={runtime.busy}
      >
        {tabs[app.page] && (
          <div
            className="workspace-tabs"
            id={
              app.page === 'overview'
                ? 'home-tabs'
                : app.page === 'mcp'
                  ? 'tools-tabs'
                  : app.page + '-tabs'
            }
          >
            <Tabs
              items={tabs[app.page]}
              current={app.tab}
              choose={(tab) => app.go(app.page, tab)}
            />
          </div>
        )}
        <Learning />
        <ErrorBoundary key={app.page + ':' + app.tab}>
          <Route />
        </ErrorBoundary>
      </AppShell>
      <ModalView value={runtime.modal} close={app.close} error={runtime.error} />
    </RuntimeContext.Provider>
  );
}
createRoot(document.getElementById('app-root')!).render(<App />);
