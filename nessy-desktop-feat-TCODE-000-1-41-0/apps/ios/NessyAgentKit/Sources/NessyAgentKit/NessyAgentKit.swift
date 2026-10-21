// apps/ios/NessyAgentKit/Sources/NessyAgentKit/NessyAgentKit.swift
/// NessyAgentKit — protocol, transport, and model layer for the Craft Agents
/// iOS/iPadOS client. Contains no UIKit/SwiftUI dependencies so it can be
/// unit-tested with `swift test` independent of the Xcode app target.
public enum NessyAgentKit {
    /// Matches `PROTOCOL_VERSION` in `packages/shared/src/protocol/types.ts`.
    public static let supportedProtocolVersion = "1.0"
}
