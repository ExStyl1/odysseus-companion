import knight from '@/assets/odysseus-knight.jpg'

/** Original user-supplied portrait; framing is CSS so the source stays intact. */
export function OdysseusPortrait({ compact = false }: { compact?: boolean }) {
  return <div className={`odysseus-portrait ${compact ? 'odysseus-portrait-compact' : ''}`}>
    <img src={knight} alt="Odysseus — рыцарь в чёрных доспехах" draggable={false} />
    <span aria-hidden="true" className="odysseus-wordmark">ODYSSEUS</span>
  </div>
}
