export * from './headless-start.ts'
export * from './storage-runtime.ts'
// The host-owned managed policy is the endpoint-managed source the
// `forceRemoteSettingsRefresh` gate reads alongside the server cache —
// `server-managed-settings.md#enforce-fail-closed-startup`: "You can also set
// this key in an endpoint-managed MDM profile or system `managed-settings.json`
// file to enforce fail-closed behavior on first launch, before any server
// payload has arrived" — so the shell needs it before the storage runtime
// exists.
export {
  loadManagedPiPolicy,
  loadManagedPiPolicyWithDiagnostics,
  managedPiPolicyPathForPlatform,
  type ManagedPiPolicyLoadV1,
} from '../pi-harness/managed-policy-loader.ts'
// The operator-visible notice for a policy file that could not be READ, needed
// at the same point for the same reason: the shell's version-gate call site
// runs before the storage runtime exists, and until P6.246 it degraded that
// fail-closed throw to a log line nobody sees in a packaged build. Exported
// from the barrel rather than through `storage-runtime.ts`, whose re-export
// block exists to keep `createStorageRuntime`'s neighbourhood readable — this
// notice has nothing to do with that runtime.
export { managedPolicyUnreadableNotice } from './managed-policy-resolution.ts'
