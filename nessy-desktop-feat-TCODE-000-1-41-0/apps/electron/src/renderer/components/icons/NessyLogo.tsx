import { NessySymbol } from './NessySymbol'
export function NessyLogo({className}: {className?:string}) {
 return <span className={className} aria-label="Odysseus" style={{display:'inline-flex',alignItems:'center',gap:12}}><NessySymbol className="size-8"/><span style={{letterSpacing:'.18em',fontWeight:600}}>ODYSSEUS</span></span>
}
