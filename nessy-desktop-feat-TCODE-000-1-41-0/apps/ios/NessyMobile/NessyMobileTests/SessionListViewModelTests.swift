// apps/ios/NessyMobile/NessyMobileTests/SessionListViewModelTests.swift
import XCTest
@testable import NessyMobile
import NessyAgentKit

@MainActor
final class SessionListViewModelTests: XCTestCase {
    func testAppliesSessionCreatedEventOptimistically() async throws {
        let viewModel = SessionListViewModel(client: nil)
        XCTAssertTrue(viewModel.sessions.isEmpty)

        // Simulate what RPCTransport would deliver on a real "sessions:create"
        // response — the view model's `apply(_:)` is the single place that
        // reconciles both the initial `load()` fetch and live push events.
        let session = Session(
            id: "s1", workspaceId: "w1", workspaceName: "Default",
            name: "New chat", preview: nil, lastMessageAt: 1_700_000_000_000,
            isProcessing: false, isFlagged: nil, permissionMode: nil,
            sessionStatus: nil, labels: nil, hasUnread: nil, model: nil, messageCount: nil
        )
        viewModel.upsert(session)
        XCTAssertEqual(viewModel.sessions.count, 1)
        XCTAssertEqual(viewModel.sessions.first?.id, "s1")

        viewModel.remove(sessionId: "s1")
        XCTAssertTrue(viewModel.sessions.isEmpty)
    }

    func testUpsertInsertsNewSessionsAtTheTop() {
        // Guards the ordering `createSession` (Step 3 below) relies on:
        // it calls `upsert(_:)` with the just-created session and expects
        // it to appear first without any extra sorting step.
        let viewModel = SessionListViewModel(client: nil, cache: nil)
        let existing = Session(
            id: "old", workspaceId: "w1", workspaceName: "Default", name: "Old",
            preview: nil, lastMessageAt: 1, isProcessing: false, isFlagged: nil,
            permissionMode: nil, sessionStatus: nil, labels: nil, hasUnread: nil,
            model: nil, messageCount: nil
        )
        viewModel.upsert(existing)

        let created = Session(
            id: "new", workspaceId: "w1", workspaceName: "Default", name: nil,
            preview: nil, lastMessageAt: 2, isProcessing: false, isFlagged: nil,
            permissionMode: nil, sessionStatus: nil, labels: nil, hasUnread: nil,
            model: nil, messageCount: nil
        )
        viewModel.upsert(created)

        XCTAssertEqual(viewModel.sessions.map(\.id), ["new", "old"])
    }

    func testResolvesConnectedWorkspaceIdForNewSession() async {
        // The "+" action must resolve a workspace even with no sessions loaded
        // yet — it prefers the connection's workspace id so it never shows
        // "No workspace available".
        let viewModel = SessionListViewModel(client: nil, cache: nil, workspaceId: "connected-ws")
        let resolved = await viewModel.resolveWorkspaceIdForNewSession()
        XCTAssertEqual(resolved, "connected-ws")
    }

    func testCreateNewSessionWithoutWorkspaceSurfacesError() async {
        let viewModel = SessionListViewModel(client: nil, cache: nil, workspaceId: nil)
        let created = await viewModel.createNewSession()
        XCTAssertNil(created)
        XCTAssertNotNil(viewModel.errorMessage)
    }

    func testWorkspaceIdForSessionPrefersSessionThenConnection() {
        let viewModel = SessionListViewModel(client: nil, cache: nil, workspaceId: "connected-ws")
        let session = Session(
            id: "s1", workspaceId: "session-ws", workspaceName: "WS",
            lastMessageAt: 1, isProcessing: false
        )
        viewModel.upsert(session)
        XCTAssertEqual(viewModel.workspaceId(for: "s1"), "session-ws")
        XCTAssertEqual(viewModel.workspaceId(for: "unknown"), "connected-ws")
    }

    func testStatusLabelFallsBackToIdWhenUnknown() {
        let viewModel = SessionListViewModel(client: nil, cache: nil)
        // No statuses loaded — unknown id returns itself; nil returns nil.
        XCTAssertEqual(viewModel.statusLabel(for: "needs-review"), "needs-review")
        XCTAssertNil(viewModel.statusLabel(for: nil))
    }

    func testVisibleSessionsSearchesNameAndPreviewCaseInsensitively() {
        let viewModel = SessionListViewModel(client: nil)
        viewModel.upsert(Session(
            id: "auth", workspaceId: "w1", workspaceName: "Default",
            name: "Authentication review", preview: "Inspect login redirects",
            lastMessageAt: 2, isProcessing: false
        ))
        viewModel.upsert(Session(
            id: "docs", workspaceId: "w1", workspaceName: "Default",
            name: "Documentation", preview: "Update setup guide",
            lastMessageAt: 1, isProcessing: false
        ))

        viewModel.searchText = "LOGIN"

        XCTAssertEqual(viewModel.visibleSessions.map(\.id), ["auth"])
    }

    func testVisibleSessionsAppliesQuickFilters() {
        let viewModel = SessionListViewModel(client: nil)
        viewModel.upsert(Session(
            id: "unread", workspaceId: "w1", workspaceName: "Default",
            lastMessageAt: 1, isProcessing: false, hasUnread: true
        ))
        viewModel.upsert(Session(
            id: "running", workspaceId: "w1", workspaceName: "Default",
            lastMessageAt: 2, isProcessing: true
        ))
        viewModel.upsert(Session(
            id: "flagged", workspaceId: "w1", workspaceName: "Default",
            lastMessageAt: 3, isProcessing: false, isFlagged: true
        ))

        viewModel.selectedFilter = .unread
        XCTAssertEqual(viewModel.visibleSessions.map(\.id), ["unread"])

        viewModel.selectedFilter = .running
        XCTAssertEqual(viewModel.visibleSessions.map(\.id), ["running"])

        viewModel.selectedFilter = .flagged
        XCTAssertEqual(viewModel.visibleSessions.map(\.id), ["flagged"])
    }

    func testLiveEventsUpdateRunningFilterState() {
        let viewModel = SessionListViewModel(client: nil)
        viewModel.upsert(Session(
            id: "s1", workspaceId: "w1", workspaceName: "Default",
            lastMessageAt: 1, isProcessing: false
        ))
        viewModel.selectedFilter = .running
        XCTAssertTrue(viewModel.visibleSessions.isEmpty)

        viewModel.apply(.textDelta(sessionId: "s1", delta: "Working", turnId: "t1"))
        XCTAssertEqual(viewModel.visibleSessions.map(\.id), ["s1"])

        viewModel.apply(.complete(sessionId: "s1"))
        XCTAssertTrue(viewModel.visibleSessions.isEmpty)
    }

    /// UA12.138 — the plan row's control: a sessions:get fixture with one
    /// top-level row, one parentSessionId child, one taskDraft:true orchestrator
    /// and one hidden:true session decodes whole (the three fields exist on the
    /// wire DTO) and `visibleSessions` yields exactly the top-level row — the
    /// desktop's board-derive.ts top-level rule, applied by the phone's flat list.
    func testVisibleSessionsExcludesBoardInternalRows() throws {
        let json = """
        [
          {"id":"top","workspaceId":"w1","workspaceName":"Default","lastMessageAt":4,"isProcessing":false},
          {"id":"child","workspaceId":"w1","workspaceName":"Default","lastMessageAt":3,"isProcessing":false,"parentSessionId":"top"},
          {"id":"draft","workspaceId":"w1","workspaceName":"Default","lastMessageAt":2,"isProcessing":false,"taskDraft":true},
          {"id":"masked","workspaceId":"w1","workspaceName":"Default","lastMessageAt":1,"isProcessing":false,"hidden":true}
        ]
        """
        let decoded = try JSONDecoder().decode([Session].self, from: Data(json.utf8))
        XCTAssertEqual(decoded.count, 4, "every row must decode — the filter is client-side, like the desktop's")

        let viewModel = SessionListViewModel(client: nil)
        for session in decoded { viewModel.upsert(session) }

        XCTAssertEqual(viewModel.sessions.count, 4, "the raw list keeps every row; only the visible list filters")
        XCTAssertEqual(viewModel.visibleSessions.map(\.id), ["top"])
    }

    /// UA12.143 — the plan row's control, pinning the DECIDED answer: the app
    /// badge (`awaitingApprovalTotal`) EXCLUDES board-internal sessions, the
    /// same rule `visibleSessions` applies since UA12.138. The defect the row
    /// names was a badge reading 1 with no visible row waiting — a Conductor
    /// child's prompt has no row on the phone (the desktop's board owns it), so
    /// the badge counted an action the phone cannot take. All three
    /// board-internal shapes are exercised; the visible top-level row's count
    /// is the whole badge.
    func testAwaitingApprovalTotalExcludesBoardInternalSessions() {
        let viewModel = SessionListViewModel(client: nil)
        viewModel.upsert(Session(
            id: "top", workspaceId: "w1", workspaceName: "Default",
            lastMessageAt: 4, isProcessing: false, awaitingApprovalCount: 2
        ))
        viewModel.upsert(Session(
            id: "child", workspaceId: "w1", workspaceName: "Default",
            lastMessageAt: 3, isProcessing: false, awaitingApprovalCount: 1,
            parentSessionId: "top"
        ))
        viewModel.upsert(Session(
            id: "draft", workspaceId: "w1", workspaceName: "Default",
            lastMessageAt: 2, isProcessing: false, awaitingApprovalCount: 1,
            taskDraft: true
        ))
        viewModel.upsert(Session(
            id: "masked", workspaceId: "w1", workspaceName: "Default",
            lastMessageAt: 1, isProcessing: false, awaitingApprovalCount: 1,
            hidden: true
        ))

        XCTAssertEqual(viewModel.awaitingApprovalTotal, 2, "the badge counts exactly the rows the list can act on")
        // The count and the list agree — the property the field's docblock states.
        XCTAssertEqual(viewModel.awaitingApprovalTotal,
                       viewModel.visibleSessions.reduce(0) { $0 + ($1.awaitingApprovalCount ?? 0) })
    }

    func testConnectionStateMarksSessionListOfflineWhileReconnecting() async {
        let transport = RPCTransport()
        let viewModel = SessionListViewModel(
            client: RPCClient(transport: transport),
            workspaceId: "w1"
        )
        XCTAssertFalse(viewModel.isOffline)

        await viewModel.transport(transport, didChangeState: .reconnecting(attempt: 1))
        XCTAssertTrue(viewModel.isOffline)

        await viewModel.transport(transport, didChangeState: .connected)
        XCTAssertFalse(viewModel.isOffline)
    }
}
