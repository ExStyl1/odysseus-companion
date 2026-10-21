export const SOURCE_LIST_SKILL_ID_PREFIX = 'source-skill:'

export function sourceListSkillId(skillSlug: string): string {
  return `${SOURCE_LIST_SKILL_ID_PREFIX}${encodeURIComponent(skillSlug)}`
}

export function isSourceListSkillId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.startsWith(SOURCE_LIST_SKILL_ID_PREFIX)
}

export function sourceListSkillSlug(id: string | null | undefined): string | null {
  if (!isSourceListSkillId(id)) return null
  const encoded = id.slice(SOURCE_LIST_SKILL_ID_PREFIX.length)
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}
