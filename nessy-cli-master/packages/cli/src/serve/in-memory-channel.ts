/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Re-export wrapper. The implementation lives in `@nestor/nessy-cli-acp-bridge`
// (lifted in #4175 PR 22a). Existing `import { createInMemoryChannel }
// from './in-memory-channel.js'` callers inside `serve/` and the SDK
// in-process bridge tests keep resolving without churn.
//
// @see ../../../acp-bridge/src/inMemoryChannel.ts for the implementation
//      plus design notes on `abort()` semantics and settlement shape.
export * from '@nestor/nessy-cli-acp-bridge/inMemoryChannel';
