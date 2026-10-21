import XCTest
@testable import NessyAgentKit

/// P6.575 / P6.372 (the effort half) — the phone can read and set a session's
/// effort tier.
///
/// Two things are pinned and they fail for different reasons:
///
///  1. the vocabulary and its ORDER, against `THINKING_LEVEL_IDS`. The
///     cross-language half of that — a tier that exists only in TypeScript — is
///     `scripts/ios-wire-enum-parity.test.ts`'s job, which is why the enum is
///     registered there; this file cannot see it and does not pretend to.
///  2. the DECODE SAFETY. `Session.thinkingLevel` is a raw `String?` precisely
///     so an unknown tier cannot fail the decode of the whole session, and that
///     is the property with a history: the permission mode enum threw on
///     `explore` once and took the entire payload with it.
final class ThinkingLevelTests: XCTestCase {

    func testTheVocabularyAndItsOrderMirrorTheServerList() {
        XCTAssertEqual(
            ThinkingLevel.allCases.map(\.rawValue),
            ["off", "low", "medium", "high", "xhigh", "max"],
            "THINKING_LEVEL_IDS order is significant — it is what a picker renders, low to max"
        )
        XCTAssertEqual(ThinkingLevel.workspaceDefault, .medium)
    }

    func testEveryTierRoundTripsThroughItsWireValue() {
        for level in ThinkingLevel.allCases {
            XCTAssertEqual(ThinkingLevel.from(rawId: level.rawValue), level)
        }
    }

    // MARK: - The decode-safety property

    func testAnUnknownTierReadsAsNoPickRatherThanCrashing() {
        XCTAssertNil(ThinkingLevel.from(rawId: "ultra"))
        XCTAssertNil(ThinkingLevel.from(rawId: nil))
        // Not case-insensitive on purpose: the server emits the ids verbatim, and
        // silently accepting a near-miss would show the user a tier their session
        // is not on.
        XCTAssertNil(ThinkingLevel.from(rawId: "Max"))
    }

    func testASessionCarryingATierThisBuildDoesNotKnowStillDecodes() throws {
        // The whole reason `thinkingLevel` is a String on the wire model. A
        // raw-value enum here would throw and the session would never appear in
        // the list at all.
        let json = """
        {"id":"s1","workspaceId":"w1","workspaceName":"W","lastMessageAt":1,
         "isProcessing":false,"thinkingLevel":"ultra"}
        """
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(session.thinkingLevel, "ultra")
        XCTAssertNil(session.effortLevel, "an unheard-of tier is no pick, not some other pick")
    }

    func testASessionCarryingAKnownTierExposesIt() throws {
        let json = """
        {"id":"s1","workspaceId":"w1","workspaceName":"W","lastMessageAt":1,
         "isProcessing":false,"thinkingLevel":"xhigh"}
        """
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(session.effortLevel, .xhigh)
    }

    func testASessionWithNoTierIsOnTheWorkspaceDefaultAndSaysSoByAbsence() throws {
        let json = """
        {"id":"s1","workspaceId":"w1","workspaceName":"W","lastMessageAt":1,"isProcessing":false}
        """
        let session = try JSONDecoder().decode(Session.self, from: Data(json.utf8))
        XCTAssertNil(session.thinkingLevel)
        XCTAssertNil(session.effortLevel)
    }

    // MARK: - The seeded read

    func testTheEffortTierIsSeededFromTheSameEnvelopeAsTheIntegration() throws {
        // P6.575: `sessions:getMessages` returns the whole Session DTO, so the
        // effort tier arrives at load rather than only on a later change. A
        // control that waits for an event opens blank.
        let json = #"{"messages":[],"isProcessing":false,"thinkingLevel":"low"}"#
        let state = try RPCClient.decodeSessionStateResult(
            try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        )
        XCTAssertEqual(state.thinkingLevel, "low")
        XCTAssertEqual(ThinkingLevel.from(rawId: state.thinkingLevel), .low)
    }

    func testAServerThatSendsNoTierReadsAsTheWorkspaceDefaultAndNotAsAnError() throws {
        let json = #"{"messages":[],"isProcessing":false}"#
        let state = try RPCClient.decodeSessionStateResult(
            try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        )
        XCTAssertNil(state.thinkingLevel)
    }

    // MARK: - The command shape

    func testTheCommandCarriesTheRawTierTheServerValidates() throws {
        // The server's `isValidThinkingLevel` compares against THINKING_LEVEL_IDS,
        // so the wire value has to be the id and not the display name. Encoded
        // here through the same JSONValue the client sends.
        let command = JSONValue.object([
            "type": .string("setThinkingLevel"),
            "level": .string(ThinkingLevel.high.rawValue),
        ])
        let data = try JSONEncoder().encode(command)
        let text = String(decoding: data, as: UTF8.self)
        XCTAssertTrue(text.contains("\"setThinkingLevel\""))
        XCTAssertTrue(text.contains("\"high\""))
        XCTAssertFalse(text.contains("High"), "the display name must never reach the wire")
    }
}
