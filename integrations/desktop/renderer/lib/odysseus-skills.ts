import catalog from '@/data/odysseus-skills.json';
export type SkillRole = 'general' | 'qa' | 'dev' | 'sa';
export type UiSkill = (typeof catalog.entries)[number];
export const UI_SKILLS: readonly UiSkill[] = catalog.entries;
const byName = new Map(UI_SKILLS.map((skill) => [skill.name, skill]));
export function skillRussianDescription(skill: {
  logicalName?: string;
  name?: string;
  description?: string;
}): string | undefined {
  const name = skill.logicalName ?? skill.name ?? '';
  const canonical = (name.split(':').at(-1) ?? name).toLocaleLowerCase('en').replace(/\s+/g, '-');
  return byName.get(name)?.description ?? byName.get(canonical)?.description ?? skill.description;
}
export function filterUiSkills(role: SkillRole, query: string): UiSkill[] {
  const words = query.toLocaleLowerCase('ru').trim().split(/\s+/).filter(Boolean);
  return UI_SKILLS.filter(
    (skill) =>
      skill.roles.includes(role) &&
      words.every((word) =>
        `${skill.name} ${skill.description} ${skill.categoryTitle}`
          .toLocaleLowerCase('ru')
          .includes(word),
      ),
  );
}
