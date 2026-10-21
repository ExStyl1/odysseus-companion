import XCTest
@testable import NessyAgentKit

/// T14. The client-side half of the switch grammar: which runtime a
/// `providerType` answers through, which tier a change falls into, and whether
/// that tier is worth interrupting the user for. The server remains the
/// authority — this only decides what to ASK before calling it.
final class RuntimeSwitchTests: XCTestCase {
    private func connection(_ slug: String, _ providerType: String) -> LlmConnection {
        LlmConnection(slug: slug, name: slug, providerType: providerType, authType: "bearer_token")
    }

    func testProviderTypesCollapseOntoTheFourRuntimes() {
        XCTAssertEqual(AgentRuntime(providerType: "pi"), .pi)
        XCTAssertEqual(AgentRuntime(providerType: "pi_compat"), .pi)
        XCTAssertEqual(AgentRuntime(providerType: "anthropic"), .anthropic)
        XCTAssertEqual(AgentRuntime(providerType: "claude-runtime"), .anthropic)
        XCTAssertEqual(AgentRuntime(providerType: "codex-runtime"), .codexRuntime)
        XCTAssertEqual(AgentRuntime(providerType: "nestor-cloud-agent"), .nestorCloudAgent)
        // An unrecognised type takes the TypeScript `default` arm rather than
        // inventing a fifth runtime.
        XCTAssertEqual(AgentRuntime(providerType: "something-new"), .pi)
    }

    func testNestorCloudAgentIsNotASwitchTarget() {
        XCTAssertFalse(connection("nestor", "nestor-cloud-agent").isSwitchTarget)
        // Negative subject: every other integration IS one, so the row cannot
        // pass on a predicate that returns false for everything.
        XCTAssertTrue(connection("pi-source", "pi").isSwitchTarget)
        XCTAssertTrue(connection("claude-gateway", "claude-runtime").isSwitchTarget)
        XCTAssertTrue(connection("codex-gateway", "codex-runtime").isSwitchTarget)
    }

    func testClassifiesTheThreeTiers() {
        XCTAssertEqual(
            RuntimeSwitch.classify(from: (slug: "pi-source", runtime: .pi), to: (slug: "pi-source", runtime: .pi)),
            .model
        )
        // Two integrations, one runtime: `anthropic` and `claude-runtime` both
        // answer through Claude.
        XCTAssertEqual(
            RuntimeSwitch.classify(from: (slug: "claude-max", runtime: .anthropic), to: (slug: "claude-gateway", runtime: .anthropic)),
            .connectionSameRuntime
        )
        XCTAssertEqual(
            RuntimeSwitch.classify(from: (slug: "pi-source", runtime: .pi), to: (slug: "codex-gateway", runtime: .codexRuntime)),
            .connectionCrossRuntime
        )
    }

    func testAnUnknownStartingIntegrationIsNotReadAsTheSameOne() {
        // `from.slug` is nil until the session state has loaded. It must not
        // compare equal to a target slug and silently downgrade to `.model`,
        // which would skip the confirmation entirely.
        XCTAssertEqual(
            RuntimeSwitch.classify(from: (slug: nil, runtime: .pi), to: (slug: "codex-gateway", runtime: .codexRuntime)),
            .connectionCrossRuntime
        )
    }

    func testOnlyTheTiersThatCostSomethingAskAQuestion() {
        XCTAssertNil(RuntimeSwitch.confirmation(kind: .model, hasHistory: true, targetName: "Pi Source"))
        // A session that has said nothing yet loses nothing: choosing an
        // integration on a fresh session is the common gesture.
        XCTAssertNil(RuntimeSwitch.confirmation(kind: .connectionCrossRuntime, hasHistory: false, targetName: "Codex"))

        let sameRuntime = RuntimeSwitch.confirmation(kind: .connectionSameRuntime, hasHistory: true, targetName: "Claude Pro/Max")
        let crossRuntime = RuntimeSwitch.confirmation(kind: .connectionCrossRuntime, hasHistory: true, targetName: "Claude Pro/Max")
        XCTAssertNotNil(sameRuntime)
        XCTAssertNotNil(crossRuntime)
        // The two tiers must say DIFFERENT things — a copy map collapsed onto
        // one string would pass both `XCTAssertNotNil`s above.
        XCTAssertNotEqual(sameRuntime?.body, crossRuntime?.body)
        XCTAssertTrue(sameRuntime?.title.contains("Claude Pro/Max") == true)
    }
}

/// The persisted switch marker, read back into copy.
///
/// This table is PORTED CASE FOR CASE from the desktop's own suite
/// (`apps/electron/src/renderer/components/app-shell/input/__tests__/runtime-switch-copy.test.ts`),
/// because the two parsers read one durable string written by one server: a
/// divergence between them is a divergence in what the same row says on two
/// screens. Both directions of compatibility are pinned here — a row written
/// before the tail existed must still read as it always did, and a tail written
/// by a newer server must not break this client.
final class RuntimeSwitchNoticeTests: XCTestCase {
    func testTurnsThePersistedMarkerIntoTwoRuntimeLabels() {
        XCTAssertEqual(
            RuntimeSwitchNotice(markerContent: "runtime_switched:pi:anthropic"),
            RuntimeSwitchNotice(from: "Pi", to: "Claude")
        )
        XCTAssertEqual(
            RuntimeSwitchNotice(markerContent: "runtime_switched:anthropic:codex-runtime"),
            RuntimeSwitchNotice(from: "Claude", to: "Codex")
        )
    }

    /// Negative subject: every other `info` row must fall through to the
    /// ordinary notice card. A parser that matched loosely would silently
    /// replace unrelated rows with a switch divider.
    func testDoesNotClaimAnOrdinaryInfoRow() {
        XCTAssertNil(RuntimeSwitchNotice(markerContent: "Session mirror error: disk full"))
        XCTAssertNil(RuntimeSwitchNotice(markerContent: "the runtime_switched: word mid-sentence"))
        XCTAssertNil(RuntimeSwitchNotice(markerContent: "runtime_switched:pi"))
        // Both segments must be non-empty — an empty one would render a
        // sentence naming "Pi" for a runtime the marker never named.
        XCTAssertNil(RuntimeSwitchNotice(markerContent: "runtime_switched::anthropic"))
        XCTAssertNil(RuntimeSwitchNotice(markerContent: "runtime_switched:pi:"))
    }

    func testReadsTheCarryOutOfTheJSONTail() {
        XCTAssertEqual(
            RuntimeSwitchNotice(markerContent: #"runtime_switched:pi:anthropic:{"carry":"native"}"#),
            RuntimeSwitchNotice(from: "Pi", to: "Claude", carry: .native)
        )
        XCTAssertEqual(
            RuntimeSwitchNotice(markerContent: #"runtime_switched:anthropic:codex-runtime:{"carry":"text"}"#),
            RuntimeSwitchNotice(from: "Claude", to: "Codex", carry: .text)
        )
        XCTAssertEqual(
            RuntimeSwitchNotice(markerContent: #"runtime_switched:codex-runtime:pi:{"carry":"anchor"}"#),
            RuntimeSwitchNotice(from: "Codex", to: "Pi", carry: .anchor)
        )
    }

    /// BACKWARD COMPAT, the half that is easy to lose. Every switch notice
    /// already in a user's transcript carries no tail and must keep reading as
    /// the sentence it read yesterday — hence a `nil` carry, not a defaulted
    /// one. Guessing `.native` here would put a claim in an old row that the
    /// switch never made.
    func testLeavesATwoSegmentMarkerExactlyAsItWas() {
        let parsed = RuntimeSwitchNotice(markerContent: "runtime_switched:pi:anthropic")
        XCTAssertEqual(parsed?.from, "Pi")
        XCTAssertEqual(parsed?.to, "Claude")
        XCTAssertNil(parsed?.carry)
        XCTAssertEqual(parsed?.localizedText, RuntimeSwitchNotice(from: "Pi", to: "Claude").localizedText)
    }

    /// A tail this build cannot use degrades to the copy that predates it
    /// rather than to a broken row. All arms matter: a newer server may add a
    /// field, a value may be one this build has no sentence for, and a
    /// truncated row must not throw out of the render path.
    func testIgnoresATailItCannotUseInsteadOfFailingTheRow() {
        let generic = RuntimeSwitchNotice(from: "Pi", to: "Claude").localizedText
        for tail in [#"{"carry":"teleport"}"#, #"{"model":"tgpt/qwen"}"#, "{not json", "", "null", "42", #"["carry"]"#] {
            let parsed = RuntimeSwitchNotice(markerContent: "runtime_switched:pi:anthropic:\(tail)")
            XCTAssertEqual(parsed?.from, "Pi", "tail: \(tail)")
            XCTAssertEqual(parsed?.to, "Claude", "tail: \(tail)")
            XCTAssertNil(parsed?.carry, "tail: \(tail)")
            XCTAssertEqual(parsed?.localizedText, generic, "tail: \(tail)")
        }
        // POSITIVE CONTROL — the same shape with a value this build DOES know
        // is taken, so the refusals above are the tail and not the parser.
        XCTAssertEqual(
            RuntimeSwitchNotice(markerContent: #"runtime_switched:pi:anthropic:{"carry":"native","model":"tgpt/qwen"}"#)?.carry,
            .native
        )
    }

    /// A model id may contain `:` under our own charset, which is what kills a
    /// split-on-`:` parser the moment the tail carries one. Pinned now, on the
    /// shape the tail is already permitted to grow into, rather than after it
    /// has shipped.
    func testSurvivesAColonInsideTheTail() {
        XCTAssertEqual(
            RuntimeSwitchNotice(markerContent: #"runtime_switched:pi:anthropic:{"carry":"text","model":"a:b:c"}"#),
            RuntimeSwitchNotice(from: "Pi", to: "Claude", carry: .text)
        )
    }

    /// One sentence per outcome family, and four DIFFERENT ones. A copy map
    /// collapsed onto one string would pass every assertion above while leaving
    /// three of the four outcomes unnamed — which is the state this row exists
    /// to end. And none of them may be the raw marker, which is the bug itself.
    func testEachOutcomeGetsItsOwnSentence() {
        let sentences = ([nil] + HistoryCarryPlan.allCases.map { Optional($0) }).map {
            RuntimeSwitchNotice(from: "Pi", to: "Claude", carry: $0).localizedText
        }
        XCTAssertEqual(Set(sentences).count, 4)
        for sentence in sentences {
            XCTAssertTrue(sentence.contains("Pi"))
            XCTAssertTrue(sentence.contains("Claude"))
            XCTAssertFalse(sentence.contains("runtime_switched"))
        }
    }
}
