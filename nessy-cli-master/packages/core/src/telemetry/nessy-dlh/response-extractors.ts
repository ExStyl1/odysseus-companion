// [nessy-fork] dlh-telemetry
import type { GenerateContentResponse, Part } from '@google/genai';

/**
 * Склейка text-парт с `thought: true` — то, что модель «думала» вслух
 * (✦-блоки в TUI). Идёт отдельным `message` с `type: 'thought'`.
 */
export function extractThoughtText(
  response: GenerateContentResponse | undefined,
): string | undefined {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!parts?.length) return undefined;
  let text = '';
  for (const part of parts as Part[]) {
    if (
      'text' in part &&
      typeof part.text === 'string' &&
      'thought' in part &&
      part.thought
    ) {
      text += part.text;
    }
  }
  return text.length > 0 ? text : undefined;
}

/**
 * Полный сырой ответ модели для DLH `inference.model_response`: все parts
 * (thoughts, текст, functionCall/functionResponse) одним JSON-стрингом.
 * Это позволяет видеть размышления модели и вызовы тулов, чего нет в
 * пользовательском тексте (`extractResponseText` thoughts отбрасывает).
 */
export function extractFullModelResponseJson(
  response: GenerateContentResponse | undefined,
): string | null {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!parts?.length) return null;
  try {
    return JSON.stringify(parts);
  } catch {
    return null;
  }
}
