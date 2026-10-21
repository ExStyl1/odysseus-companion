/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool-call approval modes.
 *
 * Defined in this dependency-free leaf module (rather than inline in config.ts)
 * so telemetry/loggers.ts can import it as a value without pulling in the heavy
 * config.js module, which would form a loggers.js <-> config.js import cycle and
 * leave logger exports undefined when the module is loaded through importOriginal.
 */
export enum ApprovalMode {
  PLAN = 'plan',
  DEFAULT = 'default',
  AUTO_EDIT = 'auto-edit',
  AUTO = 'auto',
  YOLO = 'yolo',
}
