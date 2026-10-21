/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Authentication protocols supported by the CLI.
 *
 * Defined in this dependency-free leaf module (rather than inline in
 * contentGenerator.ts) so provider presets can read `AuthType.*` at module
 * scope without tripping the contentGenerator.js -> providers -> preset ->
 * contentGenerator.js import cycle, which would otherwise leave the enum
 * undefined during initialization.
 */
export enum AuthType {
  USE_OPENAI = 'openai',
  DP_AUTH = 'dp-auth',
  USE_GEMINI = 'gemini',
  USE_VERTEX_AI = 'vertex-ai',
  USE_ANTHROPIC = 'anthropic',
}
