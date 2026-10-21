// apps/ios/NessyMobile/NessyMobile/Chat/ChatViewModel.swift
import Foundation
import Observation
import NessyAgentKit

@Observable
@MainActor
final class ChatViewModel: RPCTransportDelegate {
    var isOffline: Bool {
        guard client != nil else { return true }
        if case .connected = connectionState { return false }
        return true
    }
    private(set) var messages: [ChatMessage] = []
    /// UB12.44 — the rows the transcript DRAWS: `messages` without the hidden
    /// ones (UB2.14), as the desktop's `groupMessagesByTurn` drops them.
    /// `messages` keeps them — the model read them, so they are history
    /// (`switchConfirmation`'s `hasHistory`) and the dedupe key for a replayed
    /// `user_message`.
    var transcriptMessages: [ChatMessage] { ChatMessage.transcriptRows(messages) }
    var draftText: String = ""
    var errorMessage: String?
    var statusMessage: String?
    var pendingPermissionRequest: PermissionRequest?
    var pendingCredentialRequest: CredentialRequest?
    var pendingAttachments: [FileAttachment] = []

    /// F7: the measured websocket frame budget is 100 MiB (M1), and base64
    /// inflates by a third, so anything over ~74 MiB cannot cross the wire at
    /// all. Refusing here — with a sentence — beats a frame the server drops
    /// without explanation.
    static let maximumAttachmentBytes = 74 * 1024 * 1024

    /// Adds an attachment, or returns the reason it cannot be added.
    @discardableResult
    func addAttachment(_ attachment: FileAttachment) -> Bool {
        guard attachment.size <= Self.maximumAttachmentBytes else {
            errorMessage = String(localized: "That file is too large to send from this device.")
            return false
        }
        pendingAttachments.append(attachment)
        return true
    }
    private(set) var isProcessing: Bool = false
    private(set) var currentModel: String?
    var permissionMode: String?
    /// F1.1165 — the mode a new session in this workspace starts in: the mode menu's "Default" badge. `nil` (an older
    /// server, or not read yet) draws no badge rather than guessing one.
    private(set) var workspaceDefaultPermissionMode: PermissionMode?
    /// P6.575 — the session's effort tier, raw, as the server sent it. `nil`
    /// means the server named none (the session is on the workspace default) and
    /// the control says so rather than guessing a tier.
    private(set) var thinkingLevel: String?
    private(set) var files: [SessionFile] = []
    private(set) var availableConnections: [LlmConnection] = []
    /// Slug of the integration this session is bound to. Seeded from the
    /// session DTO on load and kept fresh by `connection_changed`.
    private(set) var currentConnection: String?
    /// The server's own answer to "may this session move" (`switchable` on the
    /// composer capabilities). Only `nestor-cloud-agent` says no today.
    private(set) var connectionSwitchable: Bool = true
    /// F1.1069 — the modes the server says this session's integration offers
    /// (`permissions` on the composer capabilities): Nessy's own for a Nessy
    /// runtime, the cloud agent's Plan and Act for Nestor Cloud. `nil` on an
    /// older server, and the picker then offers the full unified list.
    private(set) var permissionCapabilities: ComposerCapabilities.PermissionsCapability?
    private(set) var connectionState: ConnectionState

    private let client: RPCClient?
    let sessionId: String
    let workspaceId: String?
    private var streamingMessageId: String?
    /// UA12.139 — the turn the streaming buffer belongs to, from the first
    /// delta that named one (`text_delta.turnId` is optional on the wire; the
    /// desktop's `handleTextDelta` accumulates it the same way). This is what
    /// a `text_discard` matches against — see `discardStreamingPartial(turnId:)`.
    private var streamingTurnId: String?
    private let cache: SessionCacheRepository?
    private var isLoading = false
    private var retryLoadWhenConnected = false
    private var loadFailureActive = false
    private var transientConnectionErrorActive = false

    init(
        client: RPCClient?,
        sessionId: String,
        cache: SessionCacheRepository? = nil,
        workspaceId: String? = nil
    ) {
        self.client = client
        self.sessionId = sessionId
        self.cache = cache
        self.workspaceId = workspaceId
        self.connectionState = client == nil ? .disconnected : .connected
    }

    // MARK: Notes / files / model / permission mode

    /// Loads notes.md for this session (`sessions:getNotes`).
    func loadNotes() async -> String {
        guard let client else { return "" }
        return (try? await client.getNotes(sessionId: sessionId)) ?? ""
    }

    /// Persists notes.md (`sessions:setNotes`).
    func saveNotes(_ content: String) async {
        guard let client else { return }
        do { try await client.setNotes(sessionId: sessionId, content: content) }
        catch { record(error) }
    }

    /// Loads the session file tree (`sessions:getFiles`).
    func loadFiles() async {
        guard let client else { return }
        files = (try? await client.getFiles(sessionId: sessionId)) ?? []
    }

    /// Switches the session's model (`session:setModel`).
    func setModel(_ model: String?, connection: String? = nil) async {
        guard let client, let workspaceId else { return }
        do {
            try await client.setModel(sessionId: sessionId, workspaceId: workspaceId, model: model, connection: connection)
            currentModel = model
        } catch { record(error) }
    }

    /// Loads available model connections for the model picker
    /// (`LLM_Connection:list`).
    func loadConnections() async {
        guard let client else { return }
        availableConnections = (try? await client.listLlmConnections()) ?? []
    }

    /// The integration this session is currently bound to, resolved against the
    /// loaded list. `nil` before `loadConnections`, or when the session's slug
    /// no longer names a configured connection.
    var activeConnection: LlmConnection? {
        guard let currentConnection else { return nil }
        return availableConnections.first { $0.slug == currentConnection }
    }

    /// Integrations this session may move to. `nestor-cloud-agent` is out of
    /// scope as a switch target, and the active one is not a "switch".
    var switchTargets: [LlmConnection] {
        availableConnections.filter { $0.isSwitchTarget && $0.slug != currentConnection }
    }

    /// Moves the session onto another integration, and onto its runtime when
    /// that differs (`sessions:command` `switchRuntime`).
    ///
    /// Deliberately NOT `setModel`: since T3 the model-catalog guard rejects a
    /// model that does not belong to the session's connection, so a
    /// cross-integration pick sent as a model change is a silent no-op. The
    /// switch is the only operation that moves a live session.
    func switchRuntime(to slug: String) async {
        guard let client else { return }
        do {
            try await client.switchRuntime(sessionId: sessionId, connectionSlug: slug)
            currentConnection = slug
            // The server resolves the target's model itself; the authoritative
            // value arrives as `session_model_changed`.
            currentModel = nil
        } catch { record(error) }
    }

    /// The tier a pick falls into, and the question to ask before running it.
    /// `nil` means no question — see `RuntimeSwitch.confirmation`.
    func switchConfirmation(for target: LlmConnection) -> (title: String, body: String)? {
        let kind = RuntimeSwitch.classify(
            from: (slug: currentConnection, runtime: activeConnection?.agentRuntime ?? .pi),
            to: (slug: target.slug, runtime: target.agentRuntime)
        )
        return RuntimeSwitch.confirmation(kind: kind, hasHistory: !messages.isEmpty, targetName: target.name)
    }

    /// P6.575 / P6.372 (the effort half) — changes the effort level on the
    /// machine's session, so the NEXT turn runs at it
    /// (`sessions:command` setThinkingLevel; `SessionManager.setSessionThinkingLevel`
    /// both persists it and pushes it onto the live agent).
    ///
    /// The optimistic write follows `setPermissionMode`'s shape: the local value
    /// moves only after the server accepted, so a rejected level leaves the
    /// control showing what the session is actually on.
    func setThinkingLevel(_ level: ThinkingLevel) async {
        guard let client else { return }
        do {
            try await client.setSessionThinkingLevel(sessionId: sessionId, level: level)
            thinkingLevel = level.rawValue
        } catch { record(error) }
    }

    /// Switches the session's permission mode (`sessions:command` setPermissionMode).
    func setPermissionMode(_ mode: PermissionMode) async {
        guard let client else { return }
        do {
            try await client.setSessionPermissionMode(sessionId: sessionId, mode: mode)
            permissionMode = mode.rawValue
        } catch { record(error) }
    }

    func load() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }

        guard let client else {
            messages = (try? cache?.cachedMessages(sessionId: sessionId)) ?? []
            return
        }

        await client.transport.addDelegate(self)
        connectionState = await client.transport.state

        do {
            // NESSY DEVIATION (M3): seed `isProcessing` from the SERVER, not from
            // observed events. On reconnect the server replays its event buffer,
            // so a view model that only listens can be left believing a finished
            // turn is still running — measured: the stop button persisted on an
            // idle session, and every stop press then had nothing to cancel.
            let state = try await client.getSessionState(sessionId: sessionId)
            messages = state.messages
            isProcessing = state.isProcessing
            currentConnection = state.llmConnection
            // Absent on an older server: default to switchable so the control
            // is not hidden by a field the server simply did not send.
            connectionSwitchable = state.capabilities?.connection?.switchable ?? true
            permissionCapabilities = state.capabilities?.permissions
            // P6.575 — seeded from the SERVER at load, like `permissionMode`
            // below and for the same reason: a control that only listens shows
            // nothing until something changes.
            thinkingLevel = state.thinkingLevel
            for message in messages { try? cache?.upsert(message, sessionId: sessionId) }
            if let workspaceId {
                currentModel = try? await client.getModel(sessionId: sessionId, workspaceId: workspaceId)
            }
            let modeState = try? await client.getPermissionModeState(sessionId: sessionId)
            permissionMode = modeState?.permissionMode
            workspaceDefaultPermissionMode = PermissionMode.from(rawId: modeState?.workspaceDefaultPermissionMode) // F1.1165
            retryLoadWhenConnected = false
            if loadFailureActive {
                errorMessage = nil
                loadFailureActive = false
                transientConnectionErrorActive = false
            }
        } catch {
            loadFailureActive = true
            retryLoadWhenConnected = isRecoverableConnectionError(error)
            record(error)
            if messages.isEmpty {
                messages = (try? cache?.cachedMessages(sessionId: sessionId)) ?? []
            }
        }
    }

    func send() async {
        guard let client, !draftText.isEmpty || !pendingAttachments.isEmpty else { return }
        let text = draftText
        let attachments = pendingAttachments
        draftText = ""
        pendingAttachments = []
        isProcessing = true
        do {
            // F7: store first, then reference. The phone has no filesystem the
            // server can read, so each attachment's bytes are written into the
            // session's own attachments directory by the server and the turn
            // carries the reference — the same shape the desktop produces.
            // A store that fails must not silently send a message whose
            // attachment the agent cannot open, so the failure propagates.
            var stored: [JSONValue] = []
            for attachment in attachments {
                stored.append(try await client.storeAttachment(sessionId: sessionId, attachment: attachment))
            }
            let messageId = try await client.sendMessage(
                sessionId: sessionId,
                text: text,
                attachments: attachments,
                storedAttachments: stored
            )
            // Optimistically show the sent message (with its images) immediately,
            // keyed by the server's message id so the echoed `user_message`
            // event dedupes against it instead of duplicating.
            let id = messageId ?? UUID().uuidString
            if !messages.contains(where: { $0.id == id }) {
                messages.append(ChatMessage(
                    id: id,
                    role: .user,
                    content: text,
                    timestamp: Date().timeIntervalSince1970 * 1000,
                    attachments: attachments.isEmpty ? nil : attachments.map { $0.asStoredAttachment() }
                ))
            }
        } catch {
            restoreDraft(text: text, attachments: attachments)
            record(error)
            isProcessing = false
        }
    }

    /// Stops the in-flight generation for this session (`sessions:cancel`).
    func stop() async {
        guard let client else { return }
        do {
            try await client.cancelProcessing(sessionId: sessionId)
        } catch {
            record(error)
        }
        isProcessing = false
    }

    /// Replies to a pending credential request (`sessions:respondToCredential`).
    func respondToCredential(_ response: CredentialResponse) async {
        guard let client, let request = pendingCredentialRequest else { return }
        do {
            try await client.respondToCredential(sessionId: sessionId, requestId: request.requestId, response: response)
            pendingCredentialRequest = nil
        } catch {
            record(error)
        }
    }

    /// Applies one `SessionEvent` to local chat state. Pulled out of the
    /// delegate callback so it is directly unit-testable without a transport.
    func apply(_ event: SessionEvent) {
        switch event {
        case .textDelta(let eventSessionId, let delta, let turnId):
            guard eventSessionId == sessionId else { return }
            isProcessing = true
            appendStreamingDelta(delta, turnId: turnId)
        case .textDiscard(let eventSessionId, let turnId):
            guard eventSessionId == sessionId else { return }
            discardStreamingPartial(turnId: turnId)
        case .textComplete(let eventSessionId, let text):
            guard eventSessionId == sessionId else { return }
            finalizeStreamingMessage(text: text)
        case .complete(let eventSessionId):
            guard eventSessionId == sessionId else { return }
            isProcessing = false
            statusMessage = nil
        case .status(let eventSessionId, let message):
            guard eventSessionId == sessionId else { return }
            statusMessage = message
        case .errorEvent(let eventSessionId, let error):
            guard eventSessionId == sessionId else { return }
            errorMessage = error
            isProcessing = false
        case .toolStart(let eventSessionId, let toolName, let toolUseId, let toolInput, let toolDisplayName, let toolDisplayMeta):
            guard eventSessionId == sessionId else { return }
            isProcessing = true
            messages.append(ChatMessage(
                id: toolUseId, role: .tool, content: "",
                timestamp: Date().timeIntervalSince1970 * 1000,
                toolName: toolName, toolDisplayName: toolDisplayName, toolDisplayMeta: toolDisplayMeta,
                toolUseId: toolUseId, toolInput: toolInput,
                toolStatus: "running"
            ))
        case .toolResult(let eventSessionId, let toolUseId, _, let result, let isError):
            guard eventSessionId == sessionId else { return }
            guard let index = messages.firstIndex(where: { $0.toolUseId == toolUseId }) else { return }
            messages[index].toolResult = result
            messages[index].toolStatus = (isError ?? false) ? "error" : "success"
        case .permissionRequest(let eventSessionId, let request):
            // UA12.140 — the server routes a hidden child's prompt to the
            // visible ancestor (`SessionManager.permissionSurfaceRouting`,
            // server-core): the event's `sessionId` is the CHILD's, and
            // `request.parentSessionId` names the ancestor it must surface in.
            // Accept either — guarding only on the event's session attached the
            // prompt to a session the user cannot see, which read as "no prompt
            // arrived" while the child stalled. The answer path resolves the
            // child owner server-side (`resolvePermissionChildOwner`), so
            // replying with this session's id is the supported route.
            guard eventSessionId == sessionId || request.parentSessionId == sessionId else { return }
            pendingPermissionRequest = request
        case .credentialRequest(let eventSessionId, let request):
            guard eventSessionId == sessionId else { return }
            pendingCredentialRequest = request
        case .sessionModelChanged(let eventSessionId, let model):
            guard eventSessionId == sessionId else { return }
            currentModel = model
        case .permissionModeChanged(let eventSessionId, let mode):
            guard eventSessionId == sessionId else { return }
            permissionMode = mode
        case .connectionChanged(let eventSessionId, let connectionSlug, _):
            guard eventSessionId == sessionId else { return }
            // Also fires for a switch this device did not make — the same
            // session is reachable from the desktop at the same time.
            currentConnection = connectionSlug
        case .capabilitiesChanged(let eventSessionId, let capabilities):
            guard eventSessionId == sessionId else { return }
            if let switchable = capabilities.connection?.switchable { connectionSwitchable = switchable }
            if let permissions = capabilities.permissions { permissionCapabilities = permissions }
        case .userMessage(let eventSessionId, let message, _):
            guard eventSessionId == sessionId else { return }
            // The server echoes the user's own message back as a `user_message`
            // event; append it (deduped by id) so the sender sees their message
            // immediately instead of only the assistant's reply.
            if !messages.contains(where: { $0.id == message.id }) {
                messages.append(message)
            }
        case .messageAdded(let eventSessionId, let message):
            guard eventSessionId == sessionId else { return }
            // A row the server appended with no turn behind it — today, the
            // runtime-switch notice. It is a persisted transcript row, so it
            // arrives again on the next load; deduped by id for the same reason
            // `user_message` is, and because the switch may have been made from
            // the desktop on this same session.
            if !messages.contains(where: { $0.id == message.id }) {
                messages.append(message)
            }
        default:
            break
        }
    }

    private func appendStreamingDelta(_ delta: String, turnId: String?) {
        if let turnId { streamingTurnId = turnId }
        if let streamingMessageId, let index = messages.firstIndex(where: { $0.id == streamingMessageId }) {
            messages[index].content += delta
        } else {
            let id = UUID().uuidString
            streamingMessageId = id
            streamingTurnId = turnId
            messages.append(ChatMessage(
                id: id, role: .assistant, content: delta, timestamp: Date().timeIntervalSince1970 * 1000,
                isStreaming: true
            ))
        }
    }

    /// UA12.139 — drop a failed attempt's UNFINISHED text when the host voids
    /// the turn (`text_discard`): the retried deltas would otherwise append to
    /// the failed partial ("Partial ansFull answer") until `text_complete`
    /// replaced it. Mirrors the desktop's `handleTextDiscard`
    /// (`renderer/event-processor/handlers/text.ts`): only the still-streaming
    /// partial of THAT `turnId` goes — a completed message is history, and a
    /// discard for a turn this client streamed without an id (older host) or
    /// never held at all leaves the buffer for the next `text_complete`.
    private func discardStreamingPartial(turnId: String) {
        guard let streamingMessageId, streamingTurnId == turnId else { return }
        messages.removeAll { $0.id == streamingMessageId }
        self.streamingMessageId = nil
        streamingTurnId = nil
    }

    private func finalizeStreamingMessage(text: String) {
        guard let streamingMessageId, let index = messages.firstIndex(where: { $0.id == streamingMessageId }) else {
            messages.append(ChatMessage(
                id: UUID().uuidString, role: .assistant, content: text,
                timestamp: Date().timeIntervalSince1970 * 1000, isStreaming: false
            ))
            return
        }
        messages[index].content = text
        messages[index].isStreaming = false
        self.streamingMessageId = nil
        streamingTurnId = nil
    }

    nonisolated func transport(_ transport: RPCTransport, didChangeState state: ConnectionState) async {
        await handleConnectionState(state)
    }

    nonisolated func transport(_ transport: RPCTransport, didReceiveEvent envelope: MessageEnvelope) async {
        guard envelope.channel == RPCChannels.Sessions.event,
              let firstArg = envelope.args?.first else { return }
        // NESSY PROBE (temporary): the `try?` this replaces swallowed every
        // decode failure, so an event this model cannot parse vanished with no
        // trace — which is exactly what "the card stays Running" looks like.
        do {
            let event: SessionEvent = try firstArg.decoded()
            await MainActor.run { self.apply(event) }
        } catch {
            print("[NESSY-DROP] session event failed to decode: \(error)")
        }
    }

    func respond(allowed: Bool, alwaysAllow: Bool) async {
        guard let client, let request = pendingPermissionRequest else { return }
        do {
            try await client.respondToPermission(
                sessionId: sessionId, requestId: request.requestId,
                allowed: allowed, alwaysAllow: alwaysAllow
            )
            pendingPermissionRequest = nil
        } catch {
            record(error)
        }
    }

    private func handleConnectionState(_ state: ConnectionState) async {
        connectionState = state
        if case .failed(let connectionError) = state {
            errorMessage = connectionError.message
            transientConnectionErrorActive = false
            retryLoadWhenConnected = false
            return
        }
        guard case .connected = state else { return }

        if transientConnectionErrorActive {
            errorMessage = nil
            transientConnectionErrorActive = false
        }
        guard retryLoadWhenConnected else { return }
        retryLoadWhenConnected = false
        await load()
    }

    private func record(_ error: Error) {
        errorMessage = userFacingTransportError(error)
        transientConnectionErrorActive = isRecoverableConnectionError(error)
    }

    private func restoreDraft(text: String, attachments: [FileAttachment]) {
        if draftText.isEmpty {
            draftText = text
        } else if !text.isEmpty {
            draftText = "\(text)\n\(draftText)"
        }
        pendingAttachments = attachments + pendingAttachments
    }
}
