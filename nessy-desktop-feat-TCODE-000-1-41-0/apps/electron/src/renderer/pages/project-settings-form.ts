/**
 * UA5.8 follow-up — the project page's Settings form across a reload.
 *
 * Ours, not upstream's: v0.13.4 `ProjectInfoPage.tsx` keeps the folder in the form and saves it with Save, so a pick
 * never reloads the project. Ours binds the folder at once (`projects:setFolder`) and reloads — and the server's
 * `projects:changed` broadcast reloads again — so a reload must not overwrite what the user typed and has not saved.
 * A field is re-seeded from the stored value only while it still holds what was last seeded (untouched); the first
 * load seeds every field.
 */

export interface ProjectSettingsForm {
  name: string
  description: string
  details: string
  color: string
}

export function projectSettingsSeed(config: {
  name: string
  description?: string
  details?: string
  color?: string
}): ProjectSettingsForm {
  return {
    name: config.name,
    description: config.description ?? '',
    details: config.details ?? '',
    color: config.color ?? '',
  }
}

export function reseedProjectSettings(
  current: ProjectSettingsForm,
  lastSeeded: ProjectSettingsForm | null,
  next: ProjectSettingsForm,
): ProjectSettingsForm {
  const pick = (key: keyof ProjectSettingsForm): string =>
    lastSeeded === null || current[key] === lastSeeded[key] ? next[key] : current[key]
  return { name: pick('name'), description: pick('description'), details: pick('details'), color: pick('color') }
}
