// apps/ios/NessyMobile/NessyMobile/Persistence/CachedMessage.swift
import Foundation
import SwiftData

@Model
final class CachedMessage {
    @Attribute(.unique) var id: String
    var sessionId: String
    var role: String
    var content: String
    var timestamp: Double
    /// UB12.54 — F1.351's `Message.taskNotification` (`ChatMessage.taskNotification`),
    /// kept so the offline transcript draws a background-task notification as
    /// its labelled system line, as the live one does, instead of dropping it.
    /// OPTIONAL on purpose: `RootView` opens the store with `try!` and no
    /// migration plan, so only a change SwiftData migrates by itself is safe.
    /// An optional attribute is one — measured 2026-10-17 on an on-disk store
    /// written by the pre-UB12.54 model: it opened, its rows read back nil.
    /// The same store under a non-optional `Bool` failed to open (the control).
    /// `testStoreWrittenBeforeTheTaskNotificationAttributeStillOpens` pins it.
    var taskNotification: Bool?

    init(id: String, sessionId: String, role: String, content: String, timestamp: Double, taskNotification: Bool? = nil) {
        self.id = id
        self.sessionId = sessionId
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.taskNotification = taskNotification
    }
}
