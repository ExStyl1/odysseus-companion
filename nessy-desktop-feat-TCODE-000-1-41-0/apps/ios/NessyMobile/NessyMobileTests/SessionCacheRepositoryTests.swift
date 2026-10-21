// apps/ios/NessyMobile/NessyMobileTests/SessionCacheRepositoryTests.swift
import XCTest
import SwiftData
@testable import NessyMobile
import NessyAgentKit

@MainActor
final class SessionCacheRepositoryTests: XCTestCase {
    func testCachesAndReloadsSessionsAndMessages() throws {
        let schema = Schema([CachedSession.self, CachedMessage.self])
        let container = try ModelContainer(for: schema, configurations: [.init(isStoredInMemoryOnly: true)])
        let repository = SessionCacheRepository(modelContainer: container)

        let session = Session(
            id: "s1", workspaceId: "w1", workspaceName: "Default", name: "Cached chat",
            preview: nil, lastMessageAt: 1_700_000_000_000, isProcessing: false,
            isFlagged: nil, permissionMode: nil, sessionStatus: "todo", labels: nil,
            hasUnread: nil, model: nil, messageCount: nil
        )
        try repository.upsert(session)

        let message = ChatMessage(id: "m1", role: .user, content: "hello", timestamp: 1_700_000_000_100)
        try repository.upsert(message, sessionId: "s1")

        let cachedSessions = try repository.cachedSessions()
        XCTAssertEqual(cachedSessions.map(\.id), ["s1"])

        let cachedMessages = try repository.cachedMessages(sessionId: "s1")
        XCTAssertEqual(cachedMessages.map(\.content), ["hello"])
    }

    /// UA12.138 — the offline cache skips board-internal rows, so the offline
    /// list cannot resurface as flat rows what the live list filters. The arm
    /// feeds one top-level session and one child (parentSessionId set) through
    /// the same upsert `load()` uses.
    func testBoardInternalSessionsAreNotCached() throws {
        let schema = Schema([CachedSession.self, CachedMessage.self])
        let container = try ModelContainer(for: schema, configurations: [.init(isStoredInMemoryOnly: true)])
        let repository = SessionCacheRepository(modelContainer: container)

        try repository.upsert(Session(
            id: "top", workspaceId: "w1", workspaceName: "Default",
            lastMessageAt: 2, isProcessing: false
        ))
        try repository.upsert(Session(
            id: "child", workspaceId: "w1", workspaceName: "Default",
            lastMessageAt: 1, isProcessing: false, parentSessionId: "top"
        ))

        XCTAssertEqual(try repository.cachedSessions().map(\.id), ["top"])
    }

    /// UB12.44 — a hidden row (UB2.14) cached as-is would come back offline as
    /// an ordinary user bubble, the very drawing the live transcript does not
    /// do. It is not cached, a copy cached before the fix is retracted, and the
    /// row the user typed is cached as before (the control).
    func testHiddenRowsAreNotCached() throws {
        let schema = Schema([CachedSession.self, CachedMessage.self])
        let container = try ModelContainer(for: schema, configurations: [.init(isStoredInMemoryOnly: true)])
        let repository = SessionCacheRepository(modelContainer: container)

        try repository.upsert(ChatMessage(id: "typed", role: .user, content: "hello", timestamp: 1), sessionId: "s1")
        try repository.upsert(
            ChatMessage(id: "retry", role: .user, content: "hello\n\n[linear activated]", timestamp: 2, hidden: true),
            sessionId: "s1"
        )
        XCTAssertEqual(try repository.cachedMessages(sessionId: "s1").map(\.id), ["typed"])

        // A copy cached before the fix (the flag was not decoded, so it went in
        // as a plain user row) is retracted when the flagged row passes again.
        try repository.upsert(ChatMessage(id: "legacy", role: .user, content: "hello\n\n[x activated]", timestamp: 3), sessionId: "s1")
        XCTAssertEqual(try repository.cachedMessages(sessionId: "s1").map(\.id), ["typed", "legacy"])
        try repository.upsert(
            ChatMessage(id: "legacy", role: .user, content: "hello\n\n[x activated]", timestamp: 3, hidden: true),
            sessionId: "s1"
        )
        XCTAssertEqual(try repository.cachedMessages(sessionId: "s1").map(\.id), ["typed"])
    }

    /// UB12.54 — a task notification (F1.351) is cached WITH its flag, so the
    /// offline transcript draws the labelled system line the live one draws
    /// (`isTaskNotification`), not a user bubble with literal tags. The row the
    /// user typed reads back with the flag nil (the control), and a copy cached
    /// before UB12.44 (no flag) gains it when the flagged row passes again.
    func testTaskNotificationFlagRoundTripsThroughTheCache() throws {
        let schema = Schema([CachedSession.self, CachedMessage.self])
        let container = try ModelContainer(for: schema, configurations: [.init(isStoredInMemoryOnly: true)])
        let repository = SessionCacheRepository(modelContainer: container)

        try repository.upsert(ChatMessage(id: "typed", role: .user, content: "hello", timestamp: 1), sessionId: "s1")
        try repository.upsert(
            ChatMessage(id: "notice", role: .user, content: "<task-notification>done</task-notification>", timestamp: 2, taskNotification: true),
            sessionId: "s1"
        )
        let cached = try repository.cachedMessages(sessionId: "s1")
        XCTAssertEqual(cached.map(\.id), ["typed", "notice"])
        XCTAssertEqual(cached.map(\.taskNotification), [nil, true])
        XCTAssertEqual(cached.map(\.isTaskNotification), [false, true])

        try repository.upsert(ChatMessage(id: "legacy", role: .user, content: "<task-notification>x</task-notification>", timestamp: 3), sessionId: "s1")
        XCTAssertNil(try repository.cachedMessages(sessionId: "s1").first { $0.id == "legacy" }?.taskNotification)
        try repository.upsert(
            ChatMessage(id: "legacy", role: .user, content: "<task-notification>x</task-notification>", timestamp: 3, taskNotification: true),
            sessionId: "s1"
        )
        let repaired = try repository.cachedMessages(sessionId: "s1")
        XCTAssertEqual(repaired.map(\.id), ["typed", "notice", "legacy"])
        XCTAssertEqual(repaired.last?.isTaskNotification, true)
    }

    /// UB12.54 — `RootView` opens the cache with `try!` and no migration plan,
    /// so a `CachedMessage` change SwiftData cannot migrate by itself is a crash
    /// at launch for every phone that already holds a store. This arm writes an
    /// ON-DISK store with the pre-UB12.54 model (`PreUB1254Schema`, the shape
    /// the cache shipped with before the `taskNotification` attribute;
    /// SwiftData names an entity by its class name, so it is the same entity)
    /// and reopens it the way `RootView` does. Measured 2026-10-17 on macOS
    /// SwiftData with the verbatim pre-change file in a separate process: the
    /// optional attribute opens and reads back nil; a non-optional `Bool`
    /// fails with Core Data 134110 "missing attribute values on mandatory
    /// destination attribute" — the change this arm would catch.
    func testStoreWrittenBeforeTheTaskNotificationAttributeStillOpens() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ub12-54-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("cache.store")

        do {
            let legacy = try ModelContainer(
                for: Schema([PreUB1254Schema.CachedSession.self, PreUB1254Schema.CachedMessage.self]),
                configurations: [ModelConfiguration(url: url)]
            )
            let context = ModelContext(legacy)
            context.insert(PreUB1254Schema.CachedMessage(id: "typed", sessionId: "s1", role: "user", content: "hello", timestamp: 1))
            try context.save()
        }

        let container = try ModelContainer(
            for: Schema([CachedSession.self, CachedMessage.self]),
            configurations: [ModelConfiguration(url: url)]
        )
        let repository = SessionCacheRepository(modelContainer: container)
        let cached = try repository.cachedMessages(sessionId: "s1")
        XCTAssertEqual(cached.map(\.id), ["typed"])
        XCTAssertEqual(cached.map(\.taskNotification), [nil])

        try repository.upsert(
            ChatMessage(id: "notice", role: .user, content: "<task-notification>done</task-notification>", timestamp: 2, taskNotification: true),
            sessionId: "s1"
        )
        XCTAssertEqual(try repository.cachedMessages(sessionId: "s1").map(\.taskNotification), [nil, true])
    }
}

/// The cache's models as they stood before UB12.54 added
/// `CachedMessage.taskNotification` — frozen, never edited: a store a phone
/// wrote with this shape must keep opening (see the migration arm above).
private enum PreUB1254Schema {
    @Model
    final class CachedMessage {
        @Attribute(.unique) var id: String
        var sessionId: String
        var role: String
        var content: String
        var timestamp: Double

        init(id: String, sessionId: String, role: String, content: String, timestamp: Double) {
            self.id = id
            self.sessionId = sessionId
            self.role = role
            self.content = content
            self.timestamp = timestamp
        }
    }

    @Model
    final class CachedSession {
        @Attribute(.unique) var id: String
        var workspaceId: String
        var workspaceName: String
        var name: String?
        var preview: String?
        var lastMessageAt: Double
        var isProcessing: Bool
        var sessionStatus: String?

        init(id: String, workspaceId: String, workspaceName: String, lastMessageAt: Double) {
            self.id = id
            self.workspaceId = workspaceId
            self.workspaceName = workspaceName
            self.lastMessageAt = lastMessageAt
            self.isProcessing = false
        }
    }
}
