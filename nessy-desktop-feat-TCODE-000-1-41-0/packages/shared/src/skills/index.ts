/**
 * Skills Module
 *
 * Workspace skills are specialized instructions that extend Claude's capabilities.
 */

export * from './types.ts';
export {
  ADMIN_SKILLS_DIR_ENV,
  GLOBAL_AGENT_SKILLS_DIR,
  PROJECT_AGENT_SKILLS_DIR,
  getAdminAgentSkillsDirs,
  loadSkill,
  loadAllSkills,
  invalidateSkillsCache,
  loadSkillBySlug,
  getSkillIconPath,
  deleteSkill,
  skillExists,
  listSkillSlugs,
  skillNeedsIconDownload,
  downloadSkillIcon,
} from './storage.ts';
export {
  BUNDLED_SKILL_SEED_RECEIPT_FILE,
  bundledSkillSlugs,
  ensureBundledSkills,
  getManagedSkillsRoot,
  readBundledSkillSeedReceipt,
} from './seed.ts';
export type {
  BundledSkillSeedEntry,
  BundledSkillSeedReason,
  BundledSkillSeedReceipt,
  EnsureBundledSkillsOptions,
} from './seed.ts';
