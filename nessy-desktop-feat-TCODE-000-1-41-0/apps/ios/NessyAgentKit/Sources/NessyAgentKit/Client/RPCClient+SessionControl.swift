// apps/ios/NessyAgentKit/Sources/NessyAgentKit/Client/RPCClient+SessionControl.swift
import Foundation

/// Session lifecycle and control channels: delete, cancel, kill shell, the
/// consolidated `sessions:command` operations, credential responses, model
/// selection, and permission-mode state. Mirrors the handlers in
/// `packages/server-core/src/handlers/rpc/sessions.ts` and `settings.ts`.
extension RPCClient {
    // MARK: Lifecycle

    /// `sessions:delete(sessionId)`.
    public func deleteSession(sessionId: String) async throws {
        try await callVoid(RPCChannels.Sessions.delete, args: [.string(sessionId)])
    }

    /// `sessions:cancel(sessionId, silent?)` — stops in-flight generation.
    public func cancelProcessing(sessionId: String, silent: Bool = false) async throws {
        try await callVoid(RPCChannels.Sessions.cancel, args: [.string(sessionId), .bool(silent)])
    }

    /// `sessions:killShell(sessionId, shellId)` — kills a background shell.
    public func killShell(sessionId: String, shellId: String) async throws {
        try await callVoid(RPCChannels.Sessions.killShell, args: [.string(sessionId), .string(shellId)])
    }

    // MARK: Consolidated `sessions:command`

    /// Sends one `SessionCommand` object `{ type, ... }` for `sessionId`.
    private func sendCommand(_ sessionId: String, _ command: JSONValue) async throws {
        try await callVoid(RPCChannels.Sessions.command, args: [.string(sessionId), command])
    }

    public func renameSession(sessionId: String, name: String) async throws {
        try await sendCommand(sessionId, .object(["type": .string("rename"), "name": .string(name)]))
    }

    public func archiveSession(sessionId: String) async throws {
        try await sendCommand(sessionId, .object(["type": .string("archive")]))
    }

    public func unarchiveSession(sessionId: String) async throws {
        try await sendCommand(sessionId, .object(["type": .string("unarchive")]))
    }

    public func flagSession(sessionId: String) async throws {
        try await sendCommand(sessionId, .object(["type": .string("flag")]))
    }

    public func unflagSession(sessionId: String) async throws {
        try await sendCommand(sessionId, .object(["type": .string("unflag")]))
    }

    public func markSessionRead(sessionId: String) async throws {
        try await sendCommand(sessionId, .object(["type": .string("markRead")]))
    }

    public func markSessionUnread(sessionId: String) async throws {
        try await sendCommand(sessionId, .object(["type": .string("markUnread")]))
    }

    public func setSessionStatus(sessionId: String, status: String) async throws {
        try await sendCommand(sessionId, .object(["type": .string("setSessionStatus"), "state": .string(status)]))
    }

    public func setSessionPermissionMode(sessionId: String, mode: PermissionMode) async throws {
        try await sendCommand(sessionId, .object(["type": .string("setPermissionMode"), "mode": .string(mode.rawValue)]))
    }

    /// P6.575 / P6.372 (the effort half) — `sessions:command(sessionId,
    /// { type: 'setThinkingLevel', level })`.
    ///
    /// NO NEW RPC, and that is the finding rather than a shortcut. The
    /// session-scoped write already existed and is already reachable from a
    /// remote device: the handler validates the level
    /// (`packages/server-core/src/handlers/rpc/sessions.ts` →
    /// `isValidThinkingLevel`, rejecting anything outside `THINKING_LEVEL_IDS`)
    /// and `SessionManager.setSessionThinkingLevel` persists it AND pushes it
    /// onto the live agent, so the next turn runs at the new effort. What was
    /// missing at HEAD was this binding: `thinkingLevel` scored 0 occurrences
    /// under `apps/ios`.
    ///
    /// UNLIKE the permission mode, there is no remote CEILING here and none is
    /// invented. `setPermissionMode` refuses `bypassPermissions` from a
    /// non-local client because a mode change can un-gate a workstation; an
    /// effort change alters how hard the model thinks and grants nothing. The
    /// server enforces no ceiling on this command, so the client claims none —
    /// a picker that hid a tier the server accepts would be a suggestion
    /// dressed as a rule.
    ///
    /// The current level is read from `Session.thinkingLevel`
    /// (`Session.effortLevel`), which the server already sends.
    public func setSessionThinkingLevel(sessionId: String, level: ThinkingLevel) async throws {
        try await sendCommand(sessionId, .object([
            "type": .string("setThinkingLevel"),
            "level": .string(level.rawValue),
        ]))
    }

    public func setSessionLabels(sessionId: String, labels: [String]) async throws {
        try await sendCommand(sessionId, .object([
            "type": .string("setLabels"),
            "labels": .array(labels.map { .string($0) }),
        ]))
    }

    // MARK: Credentials

    /// `sessions:respondToCredential(sessionId, requestId, response)`.
    public func respondToCredential(sessionId: String, requestId: String, response: CredentialResponse) async throws {
        let payload = try encodeAsJSONValue(response)
        try await callVoid(
            RPCChannels.Sessions.respondToCredential,
            args: [.string(sessionId), .string(requestId), payload]
        )
    }

    // MARK: Model

    /// `session:getModel(sessionId, workspaceId)` — returns the effective model
    /// id, or `nil` when the session uses the workspace/app default.
    public func getModel(sessionId: String, workspaceId: String) async throws -> String? {
        try await callOptional(RPCChannels.Sessions.getModel, args: [.string(sessionId), .string(workspaceId)])
    }

    // MARK: Integration

    /// `sessions:command(sessionId, { type: 'switchRuntime', connectionSlug })`
    /// — moves a LIVE session onto another integration, and onto that
    /// integration's runtime when it differs.
    ///
    /// The command carries the slug and nothing else: the desktop picker is two
    /// controls rather than one tree (plan decision, 2026-08-14), so no gesture
    /// picks an integration and a model together and the server resolves the
    /// model for the target itself. Changing only the model stays on `setModel`.
    ///
    /// The server returns a `RuntimeSwitchResult`; it is discarded here for the
    /// same reason the desktop does not render one yet — the post-switch summary
    /// waits for the fields it would show. What the session did carry over is
    /// already stated by the transcript notice the server appends, and the new
    /// integration arrives as a `connection_changed` event.
    public func switchRuntime(sessionId: String, connectionSlug: String) async throws {
        try await sendCommand(sessionId, .object([
            "type": .string("switchRuntime"),
            "connectionSlug": .string(connectionSlug),
        ]))
    }

    /// `session:setModel(sessionId, workspaceId, model?, connection?)`.
    public func setModel(sessionId: String, workspaceId: String, model: String?, connection: String? = nil) async throws {
        try await callVoid(RPCChannels.Sessions.setModel, args: [
            .string(sessionId),
            .string(workspaceId),
            model.map { JSONValue.string($0) } ?? .null,
            connection.map { JSONValue.string($0) } ?? .null,
        ])
    }

    // MARK: Permission-mode state

    /// `sessions:getPermissionModeState(sessionId)` — `nil` if session is gone.
    public func getPermissionModeState(sessionId: String) async throws -> PermissionModeState? {
        try await callOptional(RPCChannels.Sessions.getPermissionModeState, args: [.string(sessionId)])
    }
}
