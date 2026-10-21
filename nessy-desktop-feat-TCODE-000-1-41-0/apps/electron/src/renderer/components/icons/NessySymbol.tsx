interface NessySymbolProps { className?: string; 'aria-label'?: string }
/** Odysseus helmet mark. Export name retained for provider compatibility. */
export function NessySymbol({className, 'aria-label': label}: NessySymbolProps) {
 return <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg" role={label?'img':undefined} aria-label={label} aria-hidden={label?undefined:true}>
  <path d="M5 9C5 4 8 2 12 2s7 2 7 7v7l-4 5-3-2-3 2-4-5V9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
  <path d="m5 10 5 2v4l-3-2m12-4-5 2v4l3-2M12 3v6M9 2l1-1h4l1 1M12 12v7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
 </svg>
}
