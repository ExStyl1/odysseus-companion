/**
 * Pi brand mark (mono).
 *
 * Path data from @lobehub/icons-static-svg@1.94.0 `pi.svg`
 * (https://github.com/lobehub/lobe-icons), MIT — Copyright 2023 LobeHub.
 * Vendored at docs/superpowers/plans/assets/2026-08-14-lobehub-mono/.
 *
 * `size` maps onto width/height and defaults to `1em` so the mark tracks the
 * font-size of whatever renders it; color comes from `currentColor`.
 */
export function PiIcon({
  className,
  size = '1em',
  'aria-label': ariaLabel,
}: { className?: string; size?: number | string; 'aria-label'?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="currentColor"
      fillRule="evenodd"
      xmlns="http://www.w3.org/2000/svg"
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
    >
      <path clipRule="evenodd" d="M1 1h16.5v11H12v5.5H6.5V23H1V1zm5.5 5.5V12H12V6.5H6.5z" />
      <path d="M17.5 12H23v11h-5.5V12z" />
    </svg>
  )
}
