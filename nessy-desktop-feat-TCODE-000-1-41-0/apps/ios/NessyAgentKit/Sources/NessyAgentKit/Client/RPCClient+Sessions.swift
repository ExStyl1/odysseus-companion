// apps/ios/NessyAgentKit/Sources/NessyAgentKit/Client/RPCClient+Sessions.swift
import Foundation

extension RPCClient {
    /// `sessions:get` — no args; the server scopes results to the workspace
    /// sent on the handshake (`packages/server-core/src/handlers/rpc/sessions.ts:138`).
    public func listSessions() async throws -> [Session] {
        try await call(RPCChannels.Sessions.get)
    }

    /// `sessions:getMessages` — takes `sessionId`.
    ///
    /// The server returns the **full Session object with an embedded `messages`
    /// array** (see `packages/server-core/src/handlers/rpc/sessions.ts` — "Get a
    /// single session with messages"), not a bare array. Decoding the raw result
    /// as `[ChatMessage]` therefore fails with
    /// `typeMismatch(Array, found a dictionary instead)`, so we unwrap the
    /// envelope here and extract `.messages`.
    public func getMessages(sessionId: String) async throws -> [ChatMessage] {
        let result = try await transport.request(
            channel: RPCChannels.Sessions.getMessages,
            args: [.string(sessionId)]
        )
        return try RPCClient.decodeMessagesResult(result)
    }

    /// Extracts the message list from a `sessions:getMessages` result. Exposed as
    /// an internal static helper so it can be unit-tested without a live socket.
    /// Treats a `null` result (session not found) as an empty conversation.
    static func decodeMessagesResult(_ result: JSONValue) throws -> [ChatMessage] {
        if case .null = result { return [] }
        let envelope: SessionMessagesEnvelope = try result.decoded()
        return envelope.messages ?? []
    }

    /// NESSY DEVIATION (M3): `sessions:getMessages` also answers "is this
    /// session busy right now", and throwing that away is what left the composer
    /// showing a stop button on a session that was idle. A client that has just
    /// opened a session must ASK the server whether a turn is running rather than
    /// infer it from whatever events it happened to observe — on reconnect the
    /// server replays a buffer, so event history is not a reliable source of
    /// current state.
    public func getSessionState(
        sessionId: String
    ) async throws -> SessionState {
        let result = try await transport.request(
            channel: RPCChannels.Sessions.getMessages,
            args: [.string(sessionId)]
        )
        return try RPCClient.decodeSessionStateResult(result)
    }

    static func decodeSessionStateResult(_ result: JSONValue) throws -> SessionState {
        if case .null = result { return SessionState() }
        let envelope: SessionMessagesEnvelope = try result.decoded()
        return SessionState(
            messages: envelope.messages ?? [],
            isProcessing: envelope.isProcessing ?? false,
            llmConnection: envelope.llmConnection,
            capabilities: envelope.composerCapabilities,
            thinkingLevel: envelope.thinkingLevel
        )
    }

    /// The seeded-at-load view of a session.
    ///
    /// A named struct rather than the tuple this used to be: P6.575 added a
    /// fifth member, and a five-member tuple returned across a module boundary
    /// is the shape where the next addition goes to the wrong call site
    /// silently. Every member is what the SERVER answered, never an inference.
    public struct SessionState: Sendable {
        public var messages: [ChatMessage] = []
        public var isProcessing: Bool = false
        public var llmConnection: String?
        public var capabilities: ComposerCapabilities?
        /// P6.575 — the session's effort pick, raw. `nil` means the server sent
        /// none, i.e. the session is on the workspace default. Resolve it with
        /// `ThinkingLevel.from(rawId:)`; see that enum's header for why the wire
        /// value stays a string.
        public var thinkingLevel: String?
    }

    /// Minimal decodable view over the server's Session DTO. Every field is
    /// optional so an older server that omits one reads as absent rather than
    /// failing the whole decode.
    ///
    /// `llmConnection` and `composerCapabilities` are what the integration
    /// picker opens on: `connection_changed` and `capabilities_changed` keep
    /// them fresh afterwards, but a client that only listens has no value at
    /// all until something changes, and the picker would open on a blank
    /// integration row. Both ride the same Session DTO the desktop reads
    /// (`SessionManager.managedToSession`).
    private struct SessionMessagesEnvelope: Decodable {
        let messages: [ChatMessage]?
        let isProcessing: Bool?
        let llmConnection: String?
        let composerCapabilities: ComposerCapabilities?
        /// P6.575 — rides the SAME Session DTO for the same reason
        /// `llmConnection` does: a client that only listens has no effort value
        /// at all until something changes, so the picker would open on a blank
        /// row. `sessions:getMessages` returns the whole DTO
        /// (`handlers/rpc/sessions.ts` → `sessionManager.getSession`), which
        /// already carries `thinkingLevel`.
        let thinkingLevel: String?
    }

    /// NESSY DEVIATION (F7): `file:storeAttachment(sessionId, attachment)`.
    ///
    /// The phone has no filesystem the server can read, so an attachment
    /// travels as base64 and the SERVER writes it into the session's own
    /// attachments directory — the same handler and the same directory the
    /// desktop uses. That is what turns a photo taken on a phone into a file
    /// the agent can reference, rather than an image that exists only inside
    /// one message.
    public func storeAttachment(sessionId: String, attachment: FileAttachment) async throws -> JSONValue {
        try await transport.request(
            channel: RPCChannels.File.storeAttachment,
            args: [.string(sessionId), try encodeAsJSONValue(attachment)]
        )
    }

    /// `sessions:sendMessage(sessionId, message, attachments?, storedAttachments?, options?)`.
    ///
    /// F7: `storedAttachments` carries the references returned by
    /// `storeAttachment`, so the turn points at files on disk instead of
    /// re-sending their bytes.
    ///
    /// Returns the server-assigned message id (from `{ accepted, messageId }`),
    /// which the caller can use to optimistically render the sent message and
    /// dedupe it against the echoed `user_message` event.
    @discardableResult
    public func sendMessage(
        sessionId: String,
        text: String,
        attachments: [FileAttachment] = [],
        storedAttachments: [JSONValue] = []
    ) async throws -> String? {
        let attachmentsValue: JSONValue = attachments.isEmpty
            ? .null
            : try encodeAsJSONValue(attachments)
        let storedValue: JSONValue = storedAttachments.isEmpty ? .null : .array(storedAttachments)
        let result = try await transport.request(
            channel: RPCChannels.Sessions.sendMessage,
            args: [.string(sessionId), .string(text), attachmentsValue, storedValue, .null]
        )
        if case .object(let obj) = result, case .string(let messageId)? = obj["messageId"] {
            return messageId
        }
        return nil
    }

    /// `sessions:create(workspaceId, options?)`. MVP never passes `options`.
    public func createSession(workspaceId: String) async throws -> Session {
        try await call(RPCChannels.Sessions.create, args: [.string(workspaceId), .null])
    }

    /// `sessions:respondToPermission(sessionId, requestId, allowed, alwaysAllow)`.
    public func respondToPermission(sessionId: String, requestId: String, allowed: Bool, alwaysAllow: Bool) async throws {
        try await callVoid(
            RPCChannels.Sessions.respondToPermission,
            args: [.string(sessionId), .string(requestId), .bool(allowed), .bool(alwaysAllow)]
        )
    }
}

extension RPCClient {
    /// `server:getWorkspaces` — no args.
    public func listWorkspaces() async throws -> [Workspace] {
        try await call(RPCChannels.Server.getWorkspaces)
    }
}

/// Encodes any `Encodable` value into a `JSONValue` by round-tripping
/// through `Data` — the inverse of `JSONValue.decoded()`.
func encodeAsJSONValue<T: Encodable>(_ value: T) throws -> JSONValue {
    let data = try JSONEncoder().encode(value)
    return try JSONDecoder().decode(JSONValue.self, from: data)
}
