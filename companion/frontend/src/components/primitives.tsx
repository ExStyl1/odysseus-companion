import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Button({
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`oc-button ${className}`} {...props}>
      {children}
    </button>
  );
}

export function PageHeading({
  title,
  subtitle,
  date,
}: {
  title: string;
  subtitle: string;
  date?: string;
}) {
  return (
    <>
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {date && <span className="heading-date">{date}</span>}
    </>
  );
}

export function Tabs({
  items,
  current,
  choose,
}: {
  items: [string, string][];
  current: string;
  choose: (id: string) => void;
}) {
  return (
    <>
      {items.map(([id, label]) => (
        <Button
          key={id}
          data-view={id}
          aria-pressed={id === current}
          className={id === current ? 'selected' : ''}
          onClick={() => choose(id)}
        >
          {label}
        </Button>
      ))}
    </>
  );
}

export type Catalogs = {
  collections: { id: string; name: string }[];
  projects: { id: string; name: string; collection: string }[];
};
export type ScopeProps = {
  catalogs: Catalogs;
  collection: string;
  project: string;
  onCollection: (value: string) => void;
  onProject: (value: string) => void;
  actions?: ReactNode;
  disabled?: boolean;
};

export function ScopeFields({
  catalogs,
  collection,
  project,
  onCollection,
  onProject,
  actions,
  disabled,
}: ScopeProps) {
  return (
    <>
      <label className="oc-field" htmlFor="collection">
        <span>Каталог</span>
        <select
          id="collection"
          value={collection}
          disabled={disabled}
          onChange={(e) => onCollection(e.currentTarget.value)}
        >
          {catalogs.collections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="oc-field" htmlFor="project">
        <span>Проект</span>
        <select
          id="project"
          value={project}
          disabled={disabled}
          onChange={(e) => onProject(e.currentTarget.value)}
        >
          <option value="">Все проекты каталога</option>
          {catalogs.projects
            .filter((p) => p.collection === collection)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
      </label>
      <div className="oc-scope-actions">{actions}</div>
    </>
  );
}
