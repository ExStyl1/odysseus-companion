// [nessy-fork] dlh-telemetry
import { AsyncLocalStorage } from 'node:async_hooks';

export type InferenceType = 'base' | 'recall_memory' | 'extract_memory';

/**
 * Помечает инференсы, выполняемые в рамках сбора memory перед запросом
 * (auto-memory recall). Базовый инференс по основному запросу всегда идёт
 * внутри DLH-контекста с установленным promptId, поэтому отличить recall
 * по DLH-контексту нельзя — нужен отдельный маркер вокруг recall side-query.
 */
const recallMemoryContext = new AsyncLocalStorage<true>();

export function runInRecallMemoryInference<T>(callback: () => T): T {
  return recallMemoryContext.run(true, callback);
}

export function isRecallMemoryInference(): boolean {
  return recallMemoryContext.getStore() === true;
}
