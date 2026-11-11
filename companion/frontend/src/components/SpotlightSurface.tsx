import { useRef, type ReactNode } from 'react';

// Original lightweight implementation inspired by React Bits SpotlightCard.
// Uses Companion's existing palette and motion preferences, with no idle loop.
export function SpotlightSurface({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  const surface = useRef<HTMLElement>(null);
  return (
    <section
      ref={surface}
      className={`oc-spotlight ${className}`}
      onPointerMove={(e) => {
        const root = document.documentElement;
        if (
          root.dataset.design !== 'spotlight' ||
          root.dataset.motion === 'reduced' ||
          (root.dataset.motion !== 'full' &&
            window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
        )
          return;
        const rect = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty('--light-x', `${e.clientX - rect.left}px`);
        e.currentTarget.style.setProperty('--light-y', `${e.clientY - rect.top}px`);
      }}
    >
      {children}
    </section>
  );
}
