import Foundation

/// How much a connection change costs the session. Mirrors `RuntimeSwitchKind`
/// in `packages/shared/src/protocol/runtime-switch.ts`.
public enum RuntimeSwitchKind: String, Equatable, Sendable {
    case model
    // The raw values are the WIRE spellings, not the Swift ones. Nothing reads
    // `rawValue` today — this type is computed on the device — but a `String`
    // raw-value enum whose strings differ from the union it mirrors is one
    // `Codable` conformance away from the failure this file's neighbours
    // already paid for, and the parity check
    // (`scripts/ios-wire-enum-parity.test.ts`) reads them as the mirror.
    case connectionSameRuntime = "connection-same-runtime"
    case connectionCrossRuntime = "connection-cross-runtime"
}

/// Which runtime a connection's `providerType` answers through.
///
/// A local restatement of `providerTypeToAgentProvider`
/// (`packages/shared/src/agent/backend/factory.ts`), the same hand-kept mirror
/// the renderer holds in `runtime-switch-copy.ts` and for the same reason: the
/// authority lives in the backend factory, which no client can import. Any
/// `providerType` this client has never heard of resolves to `pi`, matching the
/// TypeScript `default` arm rather than inventing a fourth runtime.
public enum AgentRuntime: String, Equatable, Sendable {
    case pi
    case anthropic
    case codexRuntime
    case nestorCloudAgent

    public init(providerType: String) {
        switch providerType {
        case "anthropic", "claude-runtime": self = .anthropic
        case "codex-runtime": self = .codexRuntime
        case "nestor-cloud-agent": self = .nestorCloudAgent
        default: self = .pi
        }
    }

    /// Short display mark. Brand names stay in English, as on the desktop.
    public var label: String {
        switch self {
        case .anthropic: return "Claude"
        case .codexRuntime: return "Codex"
        case .nestorCloudAgent: return "Nestor"
        case .pi: return "Pi"
        }
    }
}

public extension LlmConnection {
    /// The runtime this integration answers through.
    var agentRuntime: AgentRuntime { AgentRuntime(providerType: providerType) }

    /// `nestor-cloud-agent` is out of scope as a switch target and a switch
    /// source (plan decision, 2026-08-14): it is a remote agent with no local
    /// query substrate and its own mode options.
    var isSwitchTarget: Bool { agentRuntime != .nestorCloudAgent }
}

/// What actually crossed at a switch, per the switch's own plan. Mirrors
/// `HistoryCarryPlan` in `packages/shared/src/protocol/runtime-switch.ts`.
public enum HistoryCarryPlan: String, Equatable, Sendable, CaseIterable {
    case native
    case anchor
    case text
}

/// The transcript row the server appends at a runtime change, read back into
/// something renderable.
///
/// The server writes a MACHINE-READABLE marker as the content of a `role:info`
/// message (`SessionManager.appendRuntimeSwitchNotice`):
///
///     runtime_switched:<from>:<to>
///     runtime_switched:<from>:<to>:{"carry":"native"}
///
/// It has no i18n on purpose — the row is durable, so a notice persisted in one
/// UI language must not be frozen in it. The human sentence is composed at
/// RENDER time, here, exactly as the desktop composes it in
/// `apps/electron/src/renderer/components/app-shell/input/runtime-switch-copy.ts`.
/// That file is this type's reference; the two are hand-kept mirrors and the
/// test table below is ported from its suite case for case.
public struct RuntimeSwitchNotice: Equatable, Sendable {
    /// Display label of the runtime handing over (`"Pi"`, `"Claude"`, …), not
    /// the raw provider id the marker carries.
    public let from: String
    /// Display label of the runtime taking over.
    public let to: String
    /// What crossed, when the row says so. `nil` for a marker written before
    /// the tail existed — which is why this is optional rather than defaulted:
    /// guessing `.native` for an old row would state something the switch
    /// never decided.
    public let carry: HistoryCarryPlan?

    public init(from: String, to: String, carry: HistoryCarryPlan? = nil) {
        self.from = from
        self.to = to
        self.carry = carry
    }

    /// Read a switch marker out of an `info` row's content, or `nil` when the
    /// row is an ordinary notice — in which case the caller renders it as it
    /// always did. A parser that matched loosely would silently replace
    /// unrelated rows with a switch divider.
    ///
    /// **Split by position, not by splitting on `:`.** The tail is JSON and
    /// JSON contains `:`; the tail is also allowed to grow a model id, and our
    /// own model ids may contain `:`. So the two segments are taken by index
    /// and everything after the second separator is handed to the JSON reader
    /// whole. The two-segment form has no tail and is unaffected.
    public init?(markerContent content: String) {
        guard content.hasPrefix(RuntimeSwitchNotice.markerPrefix) else { return nil }
        let rest = content.dropFirst(RuntimeSwitchNotice.markerPrefix.count)
        guard let firstSeparator = rest.firstIndex(of: ":"), firstSeparator != rest.startIndex else { return nil }
        let from = String(rest[rest.startIndex..<firstSeparator])
        let afterFrom = rest[rest.index(after: firstSeparator)...]
        let secondSeparator = afterFrom.firstIndex(of: ":")
        let to = String(secondSeparator.map { afterFrom[afterFrom.startIndex..<$0] } ?? afterFrom)
        guard !to.isEmpty else { return nil }
        let tail = secondSeparator.map { String(afterFrom[afterFrom.index(after: $0)...]) } ?? ""
        self.init(
            from: AgentRuntime(providerType: from).label,
            to: AgentRuntime(providerType: to).label,
            carry: RuntimeSwitchNotice.parseCarry(tail: tail)
        )
    }

    /// The marker's fixed prefix. Public so a caller can cheaply pre-filter
    /// rows without paying for a parse.
    public static let markerPrefix = "runtime_switched:"

    /// The tail is read LENIENTLY on purpose. A tail this build does not
    /// understand must degrade to the copy that predates it, never to a broken
    /// row: the transcript is durable and a marker written by a NEWER server
    /// reaches this client routinely — that is the normal case for a phone
    /// paired to a desktop that updates on its own schedule.
    private static func parseCarry(tail: String) -> HistoryCarryPlan? {
        guard !tail.isEmpty, let data = tail.data(using: .utf8) else { return nil }
        guard let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let fields = object as? [String: Any],
              let carry = fields["carry"] as? String else { return nil }
        // An unknown value is a tail we cannot use, not a row to break on.
        return HistoryCarryPlan(rawValue: carry)
    }

    /// The notice sentence, composed now and in the reader's language.
    ///
    /// One sentence per outcome family, because the three are different events
    /// and the single original line ("the conversation so far was handed over")
    /// was only ever true of the first: a `.text` carry hands over a summary
    /// with no tool traffic, and an `.anchor` resume hands over nothing new at
    /// all — the target picks up its own thread. **The no-carry arm keeps the
    /// original sentence**, so a row written before the tail existed reads
    /// today exactly as it read when it was written.
    ///
    /// Wording mirrors `chat.runtimeSwitch.notice*` in
    /// `packages/shared/src/i18n/locales/{en,ru}.json`, so the same switch
    /// reads the same on both clients.
    public var localizedText: String {
        switch carry {
        case .native:
            return String(localized: "Runtime switched: \(from) → \(to). The whole conversation was handed over, tool calls and their results included.")
        case .anchor:
            return String(localized: "Runtime switched: \(from) → \(to). \(to) picked up the conversation it already had here; only the messages it missed were handed over.")
        case .text:
            return String(localized: "Runtime switched: \(from) → \(to). Only a text summary of the recent messages was handed over — tool calls and their results were not.")
        case nil:
            return String(localized: "Runtime switched: \(from) → \(to). The conversation so far was handed over.")
        }
    }
}

public enum RuntimeSwitch {
    /// The tier a connection change falls into, computed on the client so the
    /// question can be asked BEFORE the switch runs. Mirrors
    /// `classifyConnectionSwitch` in the renderer, which mirrors
    /// `classifyRuntimeSwitch` on the server — the server remains the
    /// authority; this only decides whether to interrupt the user.
    public static func classify(
        from: (slug: String?, runtime: AgentRuntime),
        to: (slug: String, runtime: AgentRuntime)
    ) -> RuntimeSwitchKind {
        if from.slug == to.slug { return .model }
        return from.runtime == to.runtime ? .connectionSameRuntime : .connectionCrossRuntime
    }

    /// Which switches are worth interrupting the user for.
    ///
    /// Claude Code's picker asks for confirmation when the conversation has
    /// prior output rather than on every pick, and the desktop follows it; a
    /// model change inside one integration stays silent, and so does any change
    /// on a session that has said nothing yet. `nil` means: just do it.
    public static func confirmation(
        kind: RuntimeSwitchKind,
        hasHistory: Bool,
        targetName: String
    ) -> (title: String, body: String)? {
        guard hasHistory else { return nil }
        switch kind {
        case .model:
            return nil
        case .connectionSameRuntime:
            return (
                title: String(localized: "Switch to \(targetName)?"),
                body: String(localized: "The conversation continues on the same runtime. The next reply re-reads the history, so it may take longer than usual.")
            )
        case .connectionCrossRuntime:
            return (
                title: String(localized: "Switch to \(targetName)?"),
                body: String(localized: "This changes the coding runtime. The conversation so far is handed to the new runtime as context, and background work started here is stopped.")
            )
        }
    }
}
