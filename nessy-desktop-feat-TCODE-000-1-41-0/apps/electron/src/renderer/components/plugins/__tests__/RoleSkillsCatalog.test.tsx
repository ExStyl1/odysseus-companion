import * as React from 'react'
import {test,expect,beforeAll} from 'bun:test'
import {createInstance} from 'i18next'
import {I18nextProvider,initReactI18next} from 'react-i18next'
import {renderToStaticMarkup} from 'react-dom/server'
import {AppShellProvider} from '@/context/AppShellContext'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import {RoleSkillsCatalog} from '../RoleSkillsCatalog'
import {filterUiSkills,skillRussianDescription,UI_SKILLS} from '@/lib/odysseus-skills'
const i18n=createInstance()
beforeAll(async()=>{await i18n.use(initReactI18next).init({lng:'ru',fallbackLng:'ru',keySeparator:false,resources:{ru:{translation:ru}},interpolation:{escapeValue:false}})})
test('catalog renders four accessible role tabs and a bounded set of Russian skill cards',()=>{
 const html=renderToStaticMarkup(<I18nextProvider i18n={i18n}><AppShellProvider value={{isCompactMode:false,capabilityCatalog:null,openNewChat:async()=>{}} as any}><RoleSkillsCatalog onManagePlugins={()=>{}}/></AppShellProvider></I18nextProvider>)
 expect((html.match(/role="tab"/g)||[]).length).toBe(4)
 expect(html).toContain('Общие');expect(html).toContain('>QA<');expect(html).toContain('>DEV<');expect(html).toContain('>SA<')
 expect(html).toContain('aria-selected="true"');expect(html).toContain('Управление плагинами')
 expect((html.match(/<article/g)||[]).length).toBeLessThanOrEqual(36)
 expect(html).not.toContain('Use this skill to');expect(html).toContain('Применить');expect(html).toContain('Когда агент может выбрать сам');expect(html).toContain('по смыслу вашей задачи');expect(html).toContain('В текущей задаче нужно')
})
test('Russian descriptions replace native English discovery text across both logical and display names',()=>{
 expect(skillRussianDescription({logicalName:'automate',description:'Use this skill to create automations'})).toMatch(/[А-Яа-я]/)
 expect(skillRussianDescription({name:'Code Review',description:'Review changes'})).toMatch(/[А-Яа-я]/)
 expect(skillRussianDescription({logicalName:'unknown',description:'Локальное описание'})).toBe('Локальное описание')
})
test('role-scoped search matches Russian descriptions and stable invocation names',()=>{
 expect(filterUiSkills('qa','generate-tests').some(s=>s.name==='generate-tests')).toBe(true)
 expect(filterUiSkills('sa','терминах').some(s=>s.name==='domain-modeling')).toBe(true)
 expect(filterUiSkills('general','   BrOwSeR  ').some(s=>s.name==='browser')).toBe(true)
 expect(filterUiSkills('dev','несуществующий-особый-навык')).toHaveLength(0)
 expect(UI_SKILLS.every(s=>s.roles.length>0)).toBe(true)
})
