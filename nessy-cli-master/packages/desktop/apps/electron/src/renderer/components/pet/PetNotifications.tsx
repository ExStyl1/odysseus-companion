import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Clock, Loader2, X } from 'lucide-react';
import type {
  PetNotification,
  PetNotificationKind,
} from '@/pets/usePetNotifications';

/** Max inline option buttons before collapsing into "open in app". */
const MAX_INLINE_OPTIONS = 4;

function StatusIcon({ kind }: { kind: PetNotificationKind }) {
  const base = 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white';
  if (kind === 'running')
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neutral-400" />;
  if (kind === 'success')
    return <span className={`${base} bg-emerald-500`}><Check className="h-3.5 w-3.5" /></span>;
  if (kind === 'error')
    return <span className={`${base} bg-rose-500`}><AlertTriangle className="h-3 w-3" /></span>;
  if (kind === 'permission')
    return <span className={`${base} bg-amber-400`}><Clock className="h-3 w-3" /></span>;
  return <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-400" />;
}

interface Props {
  items: PetNotification[];
  dismiss: (sessionId: string) => void;
  /** Inline answer handler from usePetNotifications (permission cards). */
  answer: (
    n: PetNotification,
    option?: { optionId?: string; cancel?: boolean },
  ) => void;
}

function OptionButton({
  label,
  title,
  onClick,
}: {
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="max-w-full truncate rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-medium leading-none text-neutral-700 transition-colors hover:bg-neutral-800 hover:text-white"
    >
      {label}
    </button>
  );
}

/**
 * The list of notification cards (newest first). Caps its height and scrolls
 * when there are many; collapse state + the toggle live in the parent so the
 * toggle stays pinned regardless of the list.
 *
 * [nessy-fork] desktop-pet-session-aggregation: permission cards carry inline
 * answer buttons (desktop permission path / MR2 terminal input.jsonl; ACP
 * cards are display-only), and clicking an external-session card focuses its
 * terminal instead of the app window.
 */
export function PetNotifications({ items, dismiss, answer }: Props) {
  const { t } = useTranslation();

  const focus = (n: PetNotification) => {
    if (n.source === 'desktop' || !n.source) {
      void window.electronAPI?.petFocusSession?.(n.sessionId);
      return;
    }
    void window.electronAPI?.focusTerminalSession?.({
      pid: n.pid,
      workDir: n.workDir,
    });
  };

  const renderAnswerRow = (n: PetNotification) => {
    if (n.kind !== 'permission' || !n.requestId || !n.answerStyle) return null;

    if (n.answerStyle === 'none') {
      return (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            focus(n);
          }}
          className="mt-1 text-[11px] font-medium leading-none text-neutral-400 underline-offset-2 hover:text-neutral-600 hover:underline"
        >
          {t('pet.notify.openInApp')}
        </button>
      );
    }

    const optionButtons = n.options?.slice(0, MAX_INLINE_OPTIONS) ?? [];
    const overflow = (n.options?.length ?? 0) - optionButtons.length;
    return (
      <div className="mt-1 flex flex-wrap gap-1">
        {n.answerStyle === 'allow_deny' && (
          <OptionButton
            label={t('pet.notify.answer')}
            onClick={() => answer(n)}
          />
        )}
        {optionButtons.map((o) => (
          <OptionButton
            key={o.optionId}
            label={o.name}
            title={o.description}
            onClick={() => answer(n, { optionId: o.optionId })}
          />
        ))}
        {overflow > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              focus(n);
            }}
            className="rounded-full px-2 py-1 text-[11px] font-medium leading-none text-neutral-400 hover:text-neutral-600"
          >
            {t('pet.notify.more', { n: overflow })}
          </button>
        )}
        <OptionButton
          label={t('pet.notify.cancel')}
          onClick={() => answer(n, { cancel: true })}
        />
      </div>
    );
  };

  return (
    // padding + matching negative margin gives card shadows room without
    // clipping inside the scroll viewport.
    <div
      data-pet-interactive
      className="pointer-events-auto -mx-2 -my-1.5 flex max-h-[300px] w-[300px] flex-col gap-1.5 overflow-y-auto px-2 py-1.5"
    >
      {items.map((n, i) => (
        <div
          key={n.sessionId}
          onClick={() => focus(n)}
          className="group relative flex shrink-0 cursor-pointer items-center gap-2.5 rounded-2xl bg-white px-3.5 py-2 shadow-strong ring-1 ring-black/5 transition-colors hover:bg-neutral-50"
        >
          <div className="min-w-0 flex-1">
            {i === 0 && (
              <span className="mb-0.5 inline-block rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium leading-none text-neutral-500">
                {t('pet.notify.latest')}
              </span>
            )}
            {n.title && (
              <div className="truncate text-[10px] font-medium uppercase leading-none tracking-wide text-neutral-400">
                {n.title}
              </div>
            )}
            <div className="truncate text-[13px] font-medium leading-snug text-neutral-800">
              {t(n.titleKey)}
            </div>
            {n.summary && (
              <div className="mt-0.5 truncate text-[11px] leading-snug text-neutral-500">
                {n.summary}
              </div>
            )}
            {renderAnswerRow(n)}
          </div>
          <StatusIcon kind={n.kind} />
          <button
            type="button"
            aria-label="dismiss"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(n.sessionId);
            }}
            className="absolute right-1.5 top-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-neutral-700/80 text-white group-hover:flex"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
