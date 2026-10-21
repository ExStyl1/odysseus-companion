export interface SystemPromptController {
  setSystemPrompt(prompt: string): void;
}

/** Update the adapter-owned public before_agent_start prompt override. */
export function applySystemPromptOverride(
  controller: SystemPromptController,
  prompt: string,
): void {
  controller.setSystemPrompt(prompt);
}
