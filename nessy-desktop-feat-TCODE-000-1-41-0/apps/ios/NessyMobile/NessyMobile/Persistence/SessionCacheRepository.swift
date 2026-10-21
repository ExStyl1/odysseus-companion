// apps/ios/NessyMobile/NessyMobile/Persistence/SessionCacheRepository.swift
import Foundation
import SwiftData
import NessyAgentKit

/// Write-through cache for offline read access. Every successful `RPCClient`
/// fetch/event writes here; `SessionListViewModel`/`ChatViewModel` read from
/// here only when the live RPC call fails (see Task 17 for the
/// connection-state-driven read/write gating).
@MainActor
final class SessionCacheRepository {
    private let modelContext: ModelContext

    init(modelContainer: ModelContainer) {
        self.modelContext = ModelContext(modelContainer)
    }

    func upsert(_ session: Session) throws {
        // UA12.138 — board-internal rows (hidden / child / task draft) are
        // skipped, not cached: the offline list reads this cache, so caching
        // them would resurface as flat rows exactly what the live list now
        // filters. They are born board-internal (Conductor children, drafts,
        // mini sessions), so a cached visible row never needs retracting.
        guard !session.isBoardInternal else { return }
        let sessionId = session.id
        let descriptor = FetchDescriptor<CachedSession>(predicate: #Predicate { $0.id == sessionId })
        if let existing = try modelContext.fetch(descriptor).first {
            existing.name = session.name
            existing.preview = session.preview
            existing.lastMessageAt = session.lastMessageAt
            existing.isProcessing = session.isProcessing
            existing.sessionStatus = session.sessionStatus
        } else {
            modelContext.insert(CachedSession(
                id: session.id, workspaceId: session.workspaceId, workspaceName: session.workspaceName,
                name: session.name, preview: session.preview, lastMessageAt: session.lastMessageAt,
                isProcessing: session.isProcessing, sessionStatus: session.sessionStatus
            ))
        }
        try modelContext.save()
    }

    func upsert(_ message: ChatMessage, sessionId: String) throws {
        let messageId = message.id
        let descriptor = FetchDescriptor<CachedMessage>(predicate: #Predicate { $0.id == messageId })
        // UB12.44 — a hidden row (UB2.14) is not cached: the offline transcript
        // reads this cache, and the live one never draws it. A copy cached
        // before that fix is retracted when the live transcript next passes
        // through here.
        guard message.rendersInTranscript else {
            if let stale = try modelContext.fetch(descriptor).first {
                modelContext.delete(stale)
                try modelContext.save()
            }
            return
        }
        // UB12.54 — a task notification (F1.351) IS cached, with its flag, so
        // the offline transcript draws the same labelled system line the live
        // one does (it was skipped while `CachedMessage` had no place for the
        // flag). Writing the flag on an existing row too repairs a copy cached
        // before UB12.44, when it went in as a plain user row.
        if let existing = try modelContext.fetch(descriptor).first {
            existing.content = message.content
            existing.taskNotification = message.taskNotification
        } else {
            modelContext.insert(CachedMessage(
                id: message.id, sessionId: sessionId, role: message.role.rawValue,
                content: message.content, timestamp: message.timestamp,
                taskNotification: message.taskNotification
            ))
        }
        try modelContext.save()
    }

    func cachedSessions() throws -> [Session] {
        let descriptor = FetchDescriptor<CachedSession>(sortBy: [SortDescriptor(\.lastMessageAt, order: .reverse)])
        return try modelContext.fetch(descriptor).map { cached in
            Session(
                id: cached.id, workspaceId: cached.workspaceId, workspaceName: cached.workspaceName,
                name: cached.name, preview: cached.preview, lastMessageAt: cached.lastMessageAt,
                isProcessing: false, isFlagged: nil, permissionMode: nil,
                sessionStatus: cached.sessionStatus, labels: nil, hasUnread: nil, model: nil, messageCount: nil
            )
        }
    }

    func cachedMessages(sessionId: String) throws -> [ChatMessage] {
        let descriptor = FetchDescriptor<CachedMessage>(
            predicate: #Predicate { $0.sessionId == sessionId },
            sortBy: [SortDescriptor(\.timestamp, order: .forward)]
        )
        return try modelContext.fetch(descriptor).map { cached in
            ChatMessage(
                id: cached.id, role: MessageRole(rawValue: cached.role) ?? .assistant,
                content: cached.content, timestamp: cached.timestamp,
                taskNotification: cached.taskNotification
            )
        }
    }
}
