import { useEffect } from 'react';
import type { Row } from './runtime';
export const themes = (window as any).companionThemes;
export function applyAppearance(p: Row) {
  const root = document.documentElement,
    dark =
      p.theme === 'dark' ||
      (p.theme === 'system' &&
        (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true));
  for (const [key, value] of Object.entries({
    design: p.design || 'classic',
    font: p.font || 'system',
    motion: p.motion || 'system',
    theme: p.theme || 'system',
    accent: p.accent || 'theme',
    density: p.density || 'comfortable',
    effective: dark ? 'dark' : 'light',
  }))
    root.dataset[key] = value;
  root.style.colorScheme = dark ? 'dark' : 'light';
  const palette = themes[p.palette || 'odysseus'] || themes.odysseus,
    colors = dark ? palette.dark || palette : palette;
  const accents: Row = dark
    ? { gold: '#c8a66d', blue: '#89b4dc', green: '#91bda2', violet: '#bba4dc' }
    : { gold: '#806339', blue: '#356da3', green: '#34784c', violet: '#7751ab' };
  for (const [key, value] of Object.entries({
    '--bg': colors.background,
    '--text': colors.foreground,
    '--accent': accents[p.accent] || colors.accent,
    '--green': colors.success || (dark ? '#81b893' : '#34784c'),
    '--on-accent': dark ? '#171717' : '#ffffff',
    '--font-scale': String((p.fontScale || 100) / 100),
  }))
    root.style.setProperty(key, value as string);
}
export function useAppearance(p: Row) {
  useEffect(() => {
    applyAppearance(p);
    const media = window.matchMedia?.('(prefers-color-scheme: dark)'),
      change = () => applyAppearance(p);
    media?.addEventListener('change', change);
    return () => media?.removeEventListener('change', change);
  }, [p]);
}
// Pointer effects only: all page markup and events belong to React.
export function useSpotlight() {
  useEffect(() => {
    const root = document.documentElement,
      media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let frame = 0,
      active: HTMLElement | null = null;
    const allowed = () =>
      root.dataset.design === 'spotlight' &&
      root.dataset.motion !== 'reduced' &&
      !(root.dataset.motion !== 'full' && media?.matches) &&
      !document.hidden;
    const clear = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (active) {
        active.removeAttribute('data-lit');
        active.style.removeProperty('--light-x');
        active.style.removeProperty('--light-y');
      }
      active = null;
    };
    const move = (event: PointerEvent) => {
      if (!allowed()) {
        clear();
        return;
      }
      const card = (event.target as Element).closest<HTMLElement>(
        '.scenario-card,.skill-card,.metric,.design-option',
      );
      if (!card) {
        clear();
        return;
      }
      if (card !== active) {
        clear();
        active = card;
      }
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!active?.isConnected || !allowed()) {
          clear();
          return;
        }
        const box = active.getBoundingClientRect();
        active.style.setProperty('--light-x', event.clientX - box.left + 'px');
        active.style.setProperty('--light-y', event.clientY - box.top + 'px');
        active.setAttribute('data-lit', '');
      });
    };
    document.addEventListener('pointermove', move, { passive: true });
    document.addEventListener('pointerleave', clear);
    document.addEventListener('visibilitychange', clear);
    window.addEventListener('blur', clear);
    media?.addEventListener('change', clear);
    const observer = new MutationObserver(clear);
    observer.observe(root, { attributes: true, attributeFilter: ['data-design', 'data-motion'] });
    return () => {
      clear();
      observer.disconnect();
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerleave', clear);
      document.removeEventListener('visibilitychange', clear);
      window.removeEventListener('blur', clear);
      media?.removeEventListener('change', clear);
    };
  }, []);
}
