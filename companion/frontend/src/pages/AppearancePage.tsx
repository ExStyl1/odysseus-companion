import { useRef, useState, type CSSProperties } from 'react';

type Preferences = Record<string, string | number | unknown>;
type Colors = { background: string; foreground: string; accent: string };
type Theme = Colors & { name: string; dark?: Colors };
export type AppearanceProps = {
  preferences: Preferences;
  themes: Record<string, Theme>;
  run: (work: () => Promise<void>) => Promise<unknown>;
  save: (patch: Preferences) => Promise<Preferences>;
  apply: (preferences: Preferences) => void;
};
const designs = [
  ['classic', 'Odysseus', 'Спокойные поверхности и бронзовые акценты.'],
  ['aurora', 'Aurora', 'Мягкое сияние и полупрозрачные панели.'],
  ['spotlight', 'Spotlight', 'Свет под курсором и объёмные карточки.'],
  ['blueprint', 'Blueprint', 'Точная сетка, строгие границы и технический ритм.'],
];
const settings: {
  id: string;
  title: string;
  note: string;
  fallback: string | number;
  options: [string | number, string][];
}[] = [
  {
    id: 'theme',
    title: 'Режим оформления',
    note: 'Светлая тема, тёмная или вслед за системой.',
    fallback: 'system',
    options: [
      ['dark', 'Тёмная'],
      ['light', 'Светлая'],
      ['system', 'Как в системе'],
    ],
  },
  {
    id: 'font',
    title: 'Шрифт интерфейса',
    note: 'Системный или мягкий гуманистический рисунок.',
    fallback: 'system',
    options: [
      ['system', 'Системный'],
      ['humanist', 'Avenir / Humanist'],
    ],
  },
  {
    id: 'motion',
    title: 'Анимация',
    note: 'Системный режим учитывает настройку уменьшения движения в macOS.',
    fallback: 'system',
    options: [
      ['system', 'Как в системе'],
      ['reduced', 'Сниженная'],
      ['full', 'Полная'],
    ],
  },
  {
    id: 'accent',
    title: 'Акцентный цвет',
    note: 'Кнопки, графики и выбранные элементы.',
    fallback: 'theme',
    options: [
      ['theme', 'Цвет выбранной темы'],
      ['gold', 'Бронза Odysseus'],
      ['blue', 'Синий'],
      ['green', 'Зелёный'],
      ['violet', 'Фиолетовый'],
    ],
  },
  {
    id: 'density',
    title: 'Плотность интерфейса',
    note: 'Больше воздуха или больше информации на экране.',
    fallback: 'comfortable',
    options: [
      ['comfortable', 'Свободная'],
      ['compact', 'Компактная'],
    ],
  },
  {
    id: 'fontScale',
    title: 'Размер текста',
    note: 'Комфортный масштаб для чтения и работы.',
    fallback: 100,
    options: [
      [90, 'Меньше · 90%'],
      [100, 'Стандартный · 100%'],
      [110, 'Крупнее · 110%'],
    ],
  },
];

export function AppearancePage({ preferences, themes, run, save, apply }: AppearanceProps) {
  const [p, setPreferences] = useState(preferences);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const update = (patch: Preferences) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    void run(async () => {
      try {
        const next = await save(patch);
        apply(next);
        setPreferences(next);
      } finally {
        pending.current = false;
        setBusy(false);
      }
    });
  };
  const dark =
    p.theme === 'dark' ||
    (p.theme === 'system' && (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true));
  const available = Object.entries(themes)
    .filter(([id]) => id !== 'haze')
    .sort(([a], [b]) => (a === 'odysseus' ? -1 : b === 'odysseus' ? 1 : a.localeCompare(b)));
  return (
    <div data-react-page="appearance">
      <div className="brand-banner">
        <div>
          <span className="eyebrow">ВАШЕ ЛИЧНОЕ ПРОСТРАНСТВО</span>
          <h2>Odysseus Companion</h2>
          <p>Знания. Инструменты. Ваш рабочий ритм.</p>
        </div>
        <img src="assets/odysseus-mark.png" alt="" />
      </div>
      <div className="appearance-section">
        <h2>Стиль пространства</h2>
        <p className="muted">
          Четыре характера интерфейса. Цветовая палитра и плотность выбираются отдельно.
        </p>
        <div className="design-gallery">
          {designs.map(([id, title, note]) => (
            <button
              key={id}
              disabled={busy}
              className={`design-option ${(p.design || 'classic') === id ? 'selected' : ''}`}
              data-design={id}
              aria-pressed={(p.design || 'classic') === id}
              aria-label={`Стиль ${title}`}
              onClick={() => update({ design: id })}
            >
              <div className={`design-sample sample-${id}`} aria-hidden="true">
                <i className="sample-nav" />
                <div className="sample-body">
                  <b />
                  <span />
                  <div>
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              </div>
              <strong>{title}</strong>
              <span>{note}</span>
              {(p.design || 'classic') === id && <em>Выбран</em>}
            </button>
          ))}
        </div>
        <p className="source">
          Эффекты работают локально. Режим «Сниженная анимация» отключает движение и реакцию на
          курсор.
        </p>
        <h2>Темы Odysseus</h2>
        <p className="muted">
          Знакомые палитры из основного приложения. Выберите настроение вашего пространства.
        </p>
        <div className="theme-grid">
          {available.map(([id, theme]) => {
            const c = dark ? theme.dark || theme : theme;
            return (
              <button
                key={id}
                disabled={busy}
                className={`theme-option ${(p.palette || 'odysseus') === id ? 'selected' : ''}`}
                data-palette={id}
                aria-label={`Тема ${theme.name}`}
                aria-pressed={(p.palette || 'odysseus') === id}
                onClick={() => update({ palette: id, accent: 'theme' })}
              >
                <div
                  className="theme-thumbnail"
                  style={
                    {
                      '--preview-bg': c.background,
                      '--preview-fg': c.foreground,
                      '--preview-accent': c.accent,
                    } as CSSProperties
                  }
                  aria-hidden="true"
                >
                  <div className="mini-sidebar">
                    <i />
                    <i />
                    <i />
                    <i />
                  </div>
                  <div className="mini-content">
                    <i />
                    <i />
                    <i style={{ width: '65%' }} />
                    <div className="mini-chart">
                      {[30, 55, 40, 80, 60, 95].map((h, i) => (
                        <b key={i} style={{ height: `${h}%` }} />
                      ))}
                    </div>
                  </div>
                </div>
                <div className="theme-name">
                  <span>{theme.name}</span>
                  {(p.palette || 'odysseus') === id && <span aria-hidden="true">✓</span>}
                </div>
              </button>
            );
          })}
        </div>
        <div className="panel">
          {settings.map((setting) => (
            <div key={setting.id} className="appearance-row">
              <div>
                <label htmlFor={setting.id}>
                  <strong>{setting.title}</strong>
                </label>
                <p>{setting.note}</p>
              </div>
              <select
                id={setting.id}
                aria-label={setting.title}
                disabled={busy}
                value={String(p[setting.id] ?? setting.fallback)}
                onChange={(e) =>
                  update({
                    [setting.id]:
                      setting.id === 'fontScale'
                        ? Number(e.currentTarget.value)
                        : e.currentTarget.value,
                  })
                }
              >
                {setting.options.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
        <p className="source" role="status">
          {busy
            ? 'Сохраняем оформление…'
            : 'Настройки применяются сразу и сохраняются на этом компьютере.'}
        </p>
      </div>
    </div>
  );
}
