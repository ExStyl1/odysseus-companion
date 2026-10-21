/**
 * @nessy-agent/core
 *
 * Core types and utilities for Nessy Desktop.
 *
 * NOTE: This package currently only exports types and utilities.
 * Storage, credentials, agent, auth, mcp, and prompts are still
 * imported directly from src/ in the consuming apps.
 */

// Re-export all types
export * from './types/index.ts';
export * from './orchestration.ts';

// Re-export utilities
export * from './utils/index.ts';
