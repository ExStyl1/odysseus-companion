import { estimateTokens } from '../../utils/large-response.ts'

export function selectReattachedSkills(
  invocations: { skillId: string; invokedAt: number; body: string }[],
  perSkillTokens = 5000,
  totalTokens = 25000,
): { skillId: string; body: string }[] {
  const latest = new Map<string, { skillId: string; invokedAt: number; body: string; index: number }>()
  invocations.forEach((invocation, index) => {
    const previous = latest.get(invocation.skillId)
    if (!previous || invocation.invokedAt > previous.invokedAt
      || (invocation.invokedAt === previous.invokedAt && index > previous.index)) {
      latest.set(invocation.skillId, { ...invocation, index })
    }
  })

  const selected: { skillId: string; body: string }[] = []
  let usedTokens = 0
  for (const invocation of [...latest.values()].sort((a, b) =>
    b.invokedAt - a.invokedAt || b.index - a.index)) {
    const body = estimateTokens(invocation.body) > perSkillTokens
      ? invocation.body.slice(0, perSkillTokens * 4)
      : invocation.body
    const tokens = estimateTokens(body)
    if (usedTokens + tokens > totalTokens) break
    selected.push({ skillId: invocation.skillId, body })
    usedTokens += tokens
  }
  return selected
}
