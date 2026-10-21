/**
 * P4: thin adapter over the ONE session filesystem authority
 * (`../session-filesystem-scope.ts`). Local tools resolve every path through
 * the captured SessionFilesystemScope; no caller reconstructs roots from
 * strings and no second containment implementation exists.
 */

export {
  AgentConfigDeniedError,
  GitMetadataDeniedError,
  ManagedRootDeniedError,
  OutsideRootError,
  isInsideOrEqual,
  resolveScopedPath,
  canonicalizeForDecision,
  type ScopedPathAccess,
  type SessionFilesystemScope,
  type SessionFilesystemScopeRoot,
} from '../session-filesystem-scope.ts';
