// apps/ios/NessyMobile/NessyMobileTests/ChatViewModelTests.swift
import XCTest
@testable import NessyMobile
import NessyAgentKit

@MainActor
final class ChatViewModelTests: XCTestCase {
    func testAppliesStreamingTextDeltaToLastAssistantMessage() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        viewModel.apply(.textDelta(sessionId: "s1", delta: "Hel", turnId: "t1"))
        viewModel.apply(.textDelta(sessionId: "s1", delta: "lo", turnId: "t1"))

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages.first?.content, "Hello")
        XCTAssertEqual(viewModel.messages.first?.isStreaming, true)
    }

    func testTextCompleteFinalizesTheMessage() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        viewModel.apply(.textDelta(sessionId: "s1", delta: "Hi", turnId: "t1"))
        viewModel.apply(.textComplete(sessionId: "s1", text: "Hi there"))

        XCTAssertEqual(viewModel.messages.first?.content, "Hi there")
        XCTAssertEqual(viewModel.messages.first?.isStreaming, false)
    }

    func testEventsForOtherSessionsAreIgnored() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        viewModel.apply(.textDelta(sessionId: "other-session", delta: "nope", turnId: nil))
        XCTAssertTrue(viewModel.messages.isEmpty)
    }
}

extension ChatViewModelTests {
    func testToolStartThenToolResultUpdateTheSameMessage() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        viewModel.apply(.toolStart(
            sessionId: "s1", toolName: "Bash", toolUseId: "tool-1",
            toolInput: ["command": .string("ls -la")]
        ))
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages.first?.toolStatus, "running")

        viewModel.apply(.toolResult(
            sessionId: "s1", toolUseId: "tool-1", toolName: "Bash",
            result: "file1.txt\nfile2.txt", isError: false
        ))
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages.first?.toolResult, "file1.txt\nfile2.txt")
        XCTAssertEqual(viewModel.messages.first?.toolStatus, "success")
    }

    // F1.436 — the row keeps the host's display fields, so the card shows the
    // name the desktop row shows instead of the wire name.
    func testToolStartKeepsTheDisplayNameForTheCard() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        viewModel.apply(.toolStart(
            sessionId: "s1", toolName: "mcp__session__spawn_session", toolUseId: "tool-2",
            toolInput: [:], toolDisplayName: nil,
            toolDisplayMeta: ToolDisplayMeta(displayName: "Spawn Session", category: "native")
        ))
        XCTAssertEqual(viewModel.messages.first?.toolDisplayTitle, "Spawn Session")
        // CONTROL — the same event with no display fields still titles by wire name.
        viewModel.apply(.toolStart(sessionId: "s1", toolName: "Bash", toolUseId: "tool-3", toolInput: [:]))
        XCTAssertEqual(viewModel.messages.last?.toolDisplayTitle, "Bash")
    }
}

extension ChatViewModelTests {
    func testPermissionRequestEventSurfacesForApproval() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        let request = PermissionRequest(
            requestId: "req-1", toolName: "Bash", command: "rm -rf /tmp/x",
            description: "Delete a temp file"
        )
        viewModel.apply(.permissionRequest(sessionId: "s1", request: request))
        XCTAssertEqual(viewModel.pendingPermissionRequest?.requestId, "req-1")
    }

    /// UA12.140 — a hidden child's prompt reaches the user watching the visible
    /// ancestor: the event carries the child's eventSessionId and
    /// `request.parentSessionId` names the viewed session. Ignoring the routed
    /// shape attached the prompt to a session the user cannot see, so the
    /// approval sheet — the reason this app exists — never appeared.
    func testPermissionRequestRoutedToTheViewedAncestorSurfacesForApproval() {
        let viewModel = ChatViewModel(client: nil, sessionId: "visible-ancestor")
        let request = PermissionRequest(
            requestId: "req-child", toolName: "Bash", command: "cargo test",
            description: "Run the child's tests", parentSessionId: "visible-ancestor"
        )
        viewModel.apply(.permissionRequest(sessionId: "hidden-child", request: request))
        XCTAssertEqual(viewModel.pendingPermissionRequest?.requestId, "req-child")
    }

    /// Negative arm: a prompt neither raised by this session nor routed to it
    /// (the ancestor names a DIFFERENT session) is still ignored — accepting
    /// every parentSessionId-bearing request would surface other trees' prompts.
    func testPermissionRequestRoutedToAnotherAncestorIsIgnored() {
        let viewModel = ChatViewModel(client: nil, sessionId: "visible-ancestor")
        let request = PermissionRequest(
            requestId: "req-other", toolName: "Bash", command: "make",
            description: "Someone else's child", parentSessionId: "another-ancestor"
        )
        viewModel.apply(.permissionRequest(sessionId: "hidden-child", request: request))
        XCTAssertNil(viewModel.pendingPermissionRequest)
    }
}

extension ChatViewModelTests {
    func testIsOfflineWhenNoClientIsAvailable() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        XCTAssertTrue(viewModel.isOffline)
    }
}

extension ChatViewModelTests {
    func testUserMessageEventSurfacesOwnMessage() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        let mine = ChatMessage(id: "m1", role: .user, content: "hello", timestamp: 1)
        viewModel.apply(.userMessage(sessionId: "s1", message: mine, status: "sent"))

        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages.first?.id, "m1")
        XCTAssertEqual(viewModel.messages.first?.content, "hello")
        XCTAssertEqual(viewModel.messages.first?.role, .user)
    }

    /// UB12.44 — the hidden source-activation retry (UB2.14) arrives as a
    /// `user_message` echo like any other. It joins `messages` (history, and the
    /// dedupe key) but not `transcriptMessages`, the rows `ChatView` draws; the
    /// row the user typed stays drawn (the control).
    func testHiddenUserMessageEchoIsKeptButNotDrawn() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        let typed = ChatMessage(id: "m1", role: .user, content: "list my issues", timestamp: 1)
        let retry = ChatMessage(
            id: "m2", role: .user, content: "list my issues\n\n[linear activated]", timestamp: 2, hidden: true
        )
        viewModel.apply(.userMessage(sessionId: "s1", message: typed, status: "accepted"))
        viewModel.apply(.userMessage(sessionId: "s1", message: retry, status: "accepted"))

        XCTAssertEqual(viewModel.messages.map(\.id), ["m1", "m2"])
        XCTAssertEqual(viewModel.transcriptMessages.map(\.id), ["m1"])
    }

    func testDuplicateUserMessageEventIsDeduped() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        let mine = ChatMessage(id: "m1", role: .user, content: "hello", timestamp: 1)
        viewModel.apply(.userMessage(sessionId: "s1", message: mine, status: "sent"))
        viewModel.apply(.userMessage(sessionId: "s1", message: mine, status: "sent"))

        XCTAssertEqual(viewModel.messages.count, 1)
    }
}

extension ChatViewModelTests {
    func testProcessingBecomesTrueOnActivityAndFalseOnComplete() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        XCTAssertFalse(viewModel.isProcessing)
        viewModel.apply(.textDelta(sessionId: "s1", delta: "Hi", turnId: "t1"))
        XCTAssertTrue(viewModel.isProcessing)
        viewModel.apply(.complete(sessionId: "s1"))
        XCTAssertFalse(viewModel.isProcessing)
    }

    func testStatusMessageIsSurfacedAndClearedOnComplete() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        viewModel.apply(.status(sessionId: "s1", message: "Compacting…"))
        XCTAssertEqual(viewModel.statusMessage, "Compacting…")
        viewModel.apply(.complete(sessionId: "s1"))
        XCTAssertNil(viewModel.statusMessage)
    }

    func testCredentialRequestEventSurfacesForInput() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        let request = CredentialRequest(requestId: "c1", sourceName: "GitHub", mode: "api_key")
        viewModel.apply(.credentialRequest(sessionId: "s1", request: request))
        XCTAssertEqual(viewModel.pendingCredentialRequest?.requestId, "c1")
    }

    func testSessionModelChangedUpdatesCurrentModel() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        viewModel.apply(.sessionModelChanged(sessionId: "s1", model: "claude-opus-4-8"))
        XCTAssertEqual(viewModel.currentModel, "claude-opus-4-8")
    }

    func testEchoedUserMessageWithSameIdDoesNotDuplicateOptimisticOne() {
        // Simulate an already-shown optimistic user message, then the server's
        // echoed user_message event with the same id — it must dedupe.
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        let mine = ChatMessage(id: "server-id-1", role: .user, content: "hi", timestamp: 1)
        viewModel.apply(.userMessage(sessionId: "s1", message: mine, status: "sent"))
        viewModel.apply(.userMessage(sessionId: "s1", message: mine, status: "sent"))
        XCTAssertEqual(viewModel.messages.filter { $0.id == "server-id-1" }.count, 1)
    }

    func testConnectionStateDisablesChatWhileReconnecting() async {
        let transport = RPCTransport()
        let viewModel = ChatViewModel(
            client: RPCClient(transport: transport),
            sessionId: "s1"
        )
        XCTAssertFalse(viewModel.isOffline)

        await viewModel.transport(transport, didChangeState: .reconnecting(attempt: 1))
        XCTAssertTrue(viewModel.isOffline)

        await viewModel.transport(transport, didChangeState: .connected)
        XCTAssertFalse(viewModel.isOffline)
    }

    func testFailedSendRestoresDraftAndShowsFriendlyConnectionError() async {
        let viewModel = ChatViewModel(
            client: RPCClient(transport: RPCTransport()),
            sessionId: "s1"
        )
        viewModel.draftText = "Keep this message"

        await viewModel.send()

        XCTAssertEqual(viewModel.draftText, "Keep this message")
        XCTAssertFalse(viewModel.isProcessing)
        XCTAssertEqual(
            viewModel.errorMessage,
            "The server connection is unavailable. Reconnecting..."
        )
    }

    func testOversizedResponseIsNotTreatedAsRecoverableDisconnect() {
        let error = URLError(.dataLengthExceedsMaximum)
        XCTAssertFalse(isRecoverableConnectionError(error))
        XCTAssertEqual(
            userFacingTransportError(error),
            "This session is too large to load on this device."
        )
    }
}

// MARK: - NESSY M3 probe: does terminal state actually clear?

extension ChatViewModelTests {
    /// Measured on device: tool cards stay `Running` after `tool_result` and the
    /// composer keeps its stop button after `complete`. This feeds the exact
    /// event sequence the server emitted during that run.
    func testNessyTerminalEventsClearState() {
        let vm = ChatViewModel(client: nil, sessionId: "s1")

        vm.apply(.textDelta(sessionId: "s1", delta: "hi", turnId: nil))
        XCTAssertTrue(vm.isProcessing, "a delta should mark the turn active")

        vm.apply(.toolStart(sessionId: "s1", toolName: "Bash", toolUseId: "T1", toolInput: [:]))
        vm.apply(.toolResult(sessionId: "s1", toolUseId: "T1", toolName: "Bash", result: "ok", isError: false))
        let tool = vm.messages.first { $0.toolUseId == "T1" }
        XCTAssertEqual(tool?.toolStatus, "success", "the card must leave `running` once its result lands")

        vm.apply(.complete(sessionId: "s1"))
        XCTAssertFalse(vm.isProcessing, "complete must clear the stop button")
    }
}

// MARK: - UA12.139: a voided partial leaves the screen when the host says so

extension ChatViewModelTests {
    /// UA12.139 — `text_discard` voids a failed attempt's streamed text. The
    /// plan row's arm: a delta builds the streaming placeholder, the discard
    /// removes it BEFORE any `text_complete`, and the retry's complete text
    /// then lands as a fresh row instead of "Partial ansFull answer".
    func testTextDiscardRemovesTheStreamingPlaceholderBeforeTextComplete() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        viewModel.apply(.textDelta(sessionId: "s1", delta: "Partial ans", turnId: "t1"))
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages.first?.isStreaming, true)

        viewModel.apply(.textDiscard(sessionId: "s1", turnId: "t1"))
        XCTAssertTrue(viewModel.messages.isEmpty, "the voided partial must be gone before text_complete arrives")
        // The turn is being retried, not finished — the spinner stays.
        XCTAssertTrue(viewModel.isProcessing)

        viewModel.apply(.textComplete(sessionId: "s1", text: "Full answer"))
        XCTAssertEqual(viewModel.messages.map(\.content), ["Full answer"])
        XCTAssertEqual(viewModel.messages.first?.isStreaming, false)
    }

    /// Negative arm, the desktop's exact rule: a discard names a turn, and only
    /// the partial of THAT turn goes. A buffer streamed namelessly (older host)
    /// or held for another turn is left for the next `text_complete` to replace.
    func testTextDiscardForAnotherTurnKeepsTheStreamingPlaceholder() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        viewModel.apply(.textDelta(sessionId: "s1", delta: "Other turn", turnId: "t2"))
        viewModel.apply(.textDiscard(sessionId: "s1", turnId: "t1"))
        XCTAssertEqual(viewModel.messages.map(\.content), ["Other turn"])

        // Same outcome when the delta named no turn at all.
        let nameless = ChatViewModel(client: nil, sessionId: "s1")
        nameless.apply(.textDelta(sessionId: "s1", delta: "Nameless", turnId: nil))
        nameless.apply(.textDiscard(sessionId: "s1", turnId: "t1"))
        XCTAssertEqual(nameless.messages.map(\.content), ["Nameless"])
    }
}

// MARK: - The runtime-switch row arrives live, not only on the next load

extension ChatViewModelTests {
    /// `message_added` is how a row with no turn behind it reaches the client.
    /// It was undecoded, so the switch notice was dropped and the transcript
    /// changed runtime mid-conversation with nothing marking the boundary until
    /// the session was reopened.
    func testMessageAddedAppendsTheRowLive() {
        let viewModel = ChatViewModel(client: nil, sessionId: "s1")
        let notice = ChatMessage(
            id: "m-9", role: .info,
            content: #"runtime_switched:pi:anthropic:{"carry":"native"}"#,
            timestamp: 1
        )

        viewModel.apply(.messageAdded(sessionId: "s1", message: notice))
        XCTAssertEqual(viewModel.messages.count, 1)
        XCTAssertEqual(viewModel.messages.first?.role, .info)
        // Stored as the marker: the sentence is composed when it is drawn, so a
        // durable row is not frozen in one UI language.
        XCTAssertEqual(viewModel.messages.first?.content, notice.content)

        // The same row arrives again on the next transcript load, and from the
        // desktop making the same switch on this session — deduped by id.
        viewModel.apply(.messageAdded(sessionId: "s1", message: notice))
        XCTAssertEqual(viewModel.messages.count, 1)

        // Negative subject: another session's row must not land here.
        viewModel.apply(.messageAdded(
            sessionId: "other-session",
            message: ChatMessage(id: "m-10", role: .info, content: "runtime_switched:pi:codex-runtime", timestamp: 2)
        ))
        XCTAssertEqual(viewModel.messages.count, 1)
    }
}

// MARK: - Which transcript rows the switch divider claims

@MainActor
final class MessageBubbleRoutingTests: XCTestCase {
    private func row(_ role: MessageRole, _ content: String) -> ChatMessage {
        ChatMessage(id: "m", role: role, content: content, timestamp: 0)
    }

    /// The bug this row exists to end: an `info` row carrying the marker was
    /// drawn as an "Information" card with `runtime_switched:pi:anthropic` in
    /// it, verbatim.
    func testAnInfoMarkerRowBecomesTheNotice() {
        let notice = MessageBubble.switchNotice(for: row(.info, #"runtime_switched:pi:anthropic:{"carry":"anchor"}"#))
        XCTAssertEqual(notice, RuntimeSwitchNotice(from: "Pi", to: "Claude", carry: .anchor))
        XCTAssertFalse(notice?.localizedText.contains("runtime_switched") == true)
    }

    /// Negative subject, both halves. An ordinary notice keeps its card, and so
    /// does a row of another role — a divider that swallowed either would erase
    /// content the transcript is the only record of.
    func testEveryOtherRowKeepsItsCard() {
        XCTAssertNil(MessageBubble.switchNotice(for: row(.info, "Session mirror error: disk full")))
        XCTAssertNil(MessageBubble.switchNotice(for: row(.status, "runtime_switched:pi:anthropic")))
        XCTAssertNil(MessageBubble.switchNotice(for: row(.assistant, "runtime_switched:pi:anthropic")))
    }
}
