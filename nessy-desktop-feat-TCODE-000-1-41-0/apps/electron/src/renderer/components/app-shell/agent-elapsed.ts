import { useEffect, useMemo, useState } from 'react'

export function getAgentElapsedSeconds(
  startedAt: string | undefined,
  endedAt?: string,
  now = Date.now(),
): number | undefined {
  if (!startedAt) return undefined

  const startedMs = Date.parse(startedAt)
  if (!Number.isFinite(startedMs)) return undefined

  // Freeze at endedAt once the agent has finished; otherwise tick against now.
  const endMs = endedAt ? Date.parse(endedAt) : now
  const effectiveEnd = Number.isFinite(endMs) ? endMs : now

  return Math.max(0, Math.floor((effectiveEnd - startedMs) / 1000))
}

export function formatAgentElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

export function useAgentElapsed(
  startedAt: string | undefined,
  endedAt?: string,
): string | undefined {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Only tick while the agent is still running. Once endedAt is set the value
    // is frozen, so there is no interval to run (and none to leak). `now` is
    // deliberately absent from deps — including it recreates the interval every
    // second.
    if (endedAt) return
    if (getAgentElapsedSeconds(startedAt, undefined, Date.now()) === undefined) return

    const interval = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => clearInterval(interval)
  }, [startedAt, endedAt])

  return useMemo(() => {
    const seconds = getAgentElapsedSeconds(startedAt, endedAt, now)
    return seconds === undefined ? undefined : formatAgentElapsed(seconds)
  }, [startedAt, endedAt, now])
}
