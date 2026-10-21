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
export function filterUiSkills(
  role: SkillRole,
  query: string,
  skills: readonly UiSkill[] = UI_SKILLS,
): UiSkill[] {
  const words = query.toLocaleLowerCase('ru').trim().split(/\s+/).filter(Boolean);
  return skills.filter(
    (skill) =>
      skill.roles.includes(role) &&
      words.every((word) =>
        `${skill.name} ${skill.description} ${skill.categoryTitle}`
          .toLocaleLowerCase('ru')
          .includes(word),
      ),
  );
}

/** Native capabilities include skills discovered in an imported Nessy profile. */
export function withNativeSkills(
  capabilities: readonly {
    kind: string;
    state: string;
    logicalName?: string;
    description?: string;
  }[],
): UiSkill[] {
  const result = [...UI_SKILLS];
  const normalize = (name: string) => name.toLocaleLowerCase('en').replace(/\s+/g, '-');
  const known = new Set(result.map((skill) => normalize(skill.name)));
  for (const capability of capabilities) {
    const name = capability.logicalName;
    if (
      capability.kind !== 'skill' ||
      capability.state !== 'active' ||
      !name ||
      known.has(normalize(name))
    )
      continue;
    known.add(normalize(name));
    const roles: SkillRole[] = ['general'];
    if (/test|qa|allure|quality/i.test(name)) roles.push('qa');
    if (/code|dev|debug|git|api|build/i.test(name)) roles.push('dev');
    if (/analyst|requirements|domain|bpmn|sql/i.test(name)) roles.push('sa');
    result.push({
      ...UI_SKILLS[0]!,
      name,
      description: capability.description || 'Навык из установленного профиля Nessy.',
      roles,
      category: 'native',
      categoryTitle: 'Импортированные навыки',
      bundled: false,
      automatic: false,
      autoCriteria: [],
      when: 'Когда задача соответствует описанию навыка.',
      how: 'Нажмите «Применить» и опишите задачу агенту.',
      dependencies: 'Используются подключения и инструменты, указанные в исходном навыке.',
      requestExample: `Примени навык ${name} к моей задаче.`,
    });
  }
  return result;
}
