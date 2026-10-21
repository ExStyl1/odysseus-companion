// apps/ios/NessyAgentKit/Tests/NessyAgentKitTests/SessionMessagesDecodingTests.swift
import XCTest
@testable import NessyAgentKit

/// Guards the `sessions:getMessages` decoding contract: the server returns the
/// full Session object with an embedded `messages` array (not a bare array), so
/// `RPCClient.decodeMessagesResult` must unwrap it. Previously the client decoded
/// the raw result as `[ChatMessage]` and crashed every session open with
/// `typeMismatch: expected Array<Any> but found a dictionary instead`.
final class SessionMessagesDecodingTests: XCTestCase {
    func testExtractsMessagesFromSessionEnvelope() throws {
        let result = JSONValue.object([
            "id": .string("s1"),
            "workspaceId": .string("w1"),
            "workspaceName": .string("Default"),
            "lastMessageAt": .number(1_700_000_000_000),
            "isProcessing": .bool(false),
            "messages": .array([
                .object([
                    "id": .string("m1"),
                    "role": .string("user"),
                    "content": .string("hello"),
                    "timestamp": .number(1_700_000_000_000),
                ]),
                .object([
                    "id": .string("m2"),
                    "role": .string("assistant"),
                    "content": .string("hi there"),
                    "timestamp": .number(1_700_000_000_001),
                ]),
            ]),
        ])

        let messages = try RPCClient.decodeMessagesResult(result)
        XCTAssertEqual(messages.count, 2)
        XCTAssertEqual(messages[0].id, "m1")
        XCTAssertEqual(messages[0].role, .user)
        XCTAssertEqual(messages[1].content, "hi there")
        XCTAssertEqual(messages[1].role, .assistant)
    }

    /// UB12.44 — the hidden source-activation retry (UB2.14) and a background-task
    /// notification (F1.351) reach this client on the same transcript as the
    /// user's own rows. Before this arm `ChatMessage` dropped both flags, so the
    /// phone drew the retry as a second user bubble and the notification as words
    /// the user never typed.
    func testHiddenAndTaskNotificationRowsDecodeAndTheHiddenOneIsNotDrawn() throws {
        let result = JSONValue.object([
            "id": .string("s1"),
            "messages": .array([
                .object([
                    "id": .string("typed"),
                    "role": .string("user"),
                    "content": .string("list my issues"),
                    "timestamp": .number(1),
                ]),
                .object([
                    "id": .string("retry"),
                    "role": .string("user"),
                    "content": .string("list my issues\n\n[linear activated]"),
                    "timestamp": .number(2),
                    "hidden": .bool(true),
                ]),
                .object([
                    "id": .string("reply"),
                    "role": .string("assistant"),
                    "content": .string("Here they are."),
                    "timestamp": .number(3),
                ]),
                .object([
                    "id": .string("notice"),
                    "role": .string("user"),
                    "content": .string("<system-reminder>…</system-reminder>\n<task-notification>\nTask b1 completed\n</task-notification>"),
                    "timestamp": .number(4),
                    "taskNotification": .bool(true),
                ]),
            ]),
        ])

        let messages = try RPCClient.decodeMessagesResult(result)
        XCTAssertEqual(messages.map(\.id), ["typed", "retry", "reply", "notice"])
        // Decoded: both flags survive the wire.
        XCTAssertEqual(messages[1].hidden, true)
        XCTAssertEqual(messages[3].taskNotification, true)

        // Positive: the hidden retry is not drawn; every other row is, in order.
        XCTAssertFalse(messages[1].rendersInTranscript)
        XCTAssertEqual(ChatMessage.transcriptRows(messages).map(\.id), ["typed", "reply", "notice"])
        // The notification is drawn as the labelled line, with the block's body.
        XCTAssertTrue(messages[3].isTaskNotification)
        XCTAssertEqual(ChatMessage.taskNotificationBody(messages[3].content), "Task b1 completed")

        // CONTROL: the row the user typed carries neither flag and still draws
        // as their bubble.
        XCTAssertNil(messages[0].hidden)
        XCTAssertNil(messages[0].taskNotification)
        XCTAssertTrue(messages[0].rendersInTranscript)
        XCTAssertFalse(messages[0].isTaskNotification)
    }

    /// UB12.44 — boundaries of the two readers. `taskNotification` on a row that
    /// is not a `user` entry does not make it the line (the host sets it only on
    /// user entries), `hidden: false` draws, and a content without the block comes
    /// back whole rather than guessed at — the desktop's `taskNotificationBody`.
    func testTaskNotificationAndHiddenBoundaries() {
        let assistantFlagged = ChatMessage(id: "a", role: .assistant, content: "x", timestamp: 0, taskNotification: true)
        XCTAssertFalse(assistantFlagged.isTaskNotification)
        let explicitlyVisible = ChatMessage(id: "v", role: .user, content: "x", timestamp: 0, hidden: false)
        XCTAssertTrue(explicitlyVisible.rendersInTranscript)

        XCTAssertEqual(ChatMessage.taskNotificationBody("plain legacy text"), "plain legacy text")
        XCTAssertEqual(
            ChatMessage.taskNotificationBody("</task-notification> then <task-notification>"),
            "</task-notification> then <task-notification>"
        )
        XCTAssertEqual(ChatMessage.taskNotificationBody("<task-notification>  </task-notification>"), "")
    }

    func testNullResultDecodesToEmptyConversation() throws {
        XCTAssertEqual(try RPCClient.decodeMessagesResult(.null).count, 0)
    }

    func testSessionWithoutMessagesFieldDecodesToEmpty() throws {
        let result = JSONValue.object([
            "id": .string("s1"),
            "workspaceId": .string("w1"),
            "workspaceName": .string("Default"),
            "lastMessageAt": .number(1_700_000_000_000),
            "isProcessing": .bool(false),
        ])
        XCTAssertEqual(try RPCClient.decodeMessagesResult(result).count, 0)
    }
}
