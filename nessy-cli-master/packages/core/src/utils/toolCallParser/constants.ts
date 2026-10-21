/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const OPEN_TAG = '<tool_call>';
export const CLOSE_TAG = '</tool_call>';
export const MAX_RAW = 200_000;

/**
 * Pattern for named tool-call tags during streaming.
 * Requires an underscore in the name (snake_case) to avoid matching common
 * HTML/XML tags like <code>, <div>, <thinking>, <br>, etc.
 * Matches: <todo_write>, <read_file>, <task_create>
 * Skips:   <code>, <div>, <thinking>, <bash>
 */
export const NAMED_TAG_STREAM_RE = /<[a-z]\w*_\w+>/i;
