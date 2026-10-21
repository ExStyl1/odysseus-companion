import {
  normalizeWorkflowRecipeKey,
  type WorkflowRecipeStore,
} from '../../../shared/src/workflows/workflow-loader.ts';

export {
  normalizeWorkflowRecipeKey,
  type WorkflowRecipeStore,
} from '../../../shared/src/workflows/workflow-loader.ts';

const recipes = new Map<string, string>();

export const defaultWorkflowRecipeStore: WorkflowRecipeStore = {
  get: key => recipes.get(key),
};

export function registerWorkflowRecipe(key: string, source: string): void {
  recipes.set(normalizeWorkflowRecipeKey(key), source);
}

export function clearWorkflowRecipesForTest(): void {
  recipes.clear();
}
