/**
 * UA5.8 follow-up — the project page's Settings form keeps the user's unsaved edits across a reload.
 *
 * Ours binds the folder at once (`projects:setFolder`) and then reloads the project; the server also broadcasts
 * `projects:changed`, which reloads it again. Upstream v0.13.4 kept the folder in the form and never reloaded on a
 * pick, so a typed-but-unsaved Name or Description survived it. POSITIVE: a field the user edited keeps its edit when
 * a reload brings a new stored value. CONTROL: an untouched field takes the new stored value (another window's save
 * still shows). BOUNDARY: the first load seeds every field.
 */
import { describe, expect, it } from 'bun:test'
import { projectSettingsSeed, reseedProjectSettings } from '../project-settings-form'

const stored = projectSettingsSeed({ name: 'Repo', description: 'old', details: undefined, color: undefined })

describe('UA5.8 follow-up — reseedProjectSettings', () => {
  it('POSITIVE: edited fields keep the edit across a reload (a folder bind, a projects:changed broadcast)', () => {
    const current = { ...stored, name: 'Typed name', description: 'typed description' }
    const reloaded = projectSettingsSeed({ name: 'Repo', description: 'old', details: undefined, color: undefined })
    expect(reseedProjectSettings(current, stored, reloaded)).toEqual(current)
  })

  it('CONTROL: an untouched field takes the newly stored value, an edited one beside it is kept', () => {
    const current = { ...stored, name: 'Typed name' }
    const reloaded = projectSettingsSeed({ name: 'Renamed elsewhere', description: 'new', details: 'd', color: '#6366f1' })
    expect(reseedProjectSettings(current, stored, reloaded)).toEqual({
      name: 'Typed name',
      description: 'new',
      details: 'd',
      color: '#6366f1',
    })
  })

  it('BOUNDARY: the first load (nothing seeded yet) seeds every field, absent ones as empty strings', () => {
    const blank = { name: '', description: '', details: '', color: '' }
    expect(reseedProjectSettings(blank, null, stored)).toEqual({ name: 'Repo', description: 'old', details: '', color: '' })
  })
})
