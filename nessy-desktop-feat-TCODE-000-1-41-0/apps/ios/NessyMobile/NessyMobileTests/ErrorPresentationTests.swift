import XCTest
import NessyAgentKit
@testable import NessyMobile

/// F14-UI — the owner screenshotted a banner showing
/// `remote(NessyAgentKit.WireError(code: …authFailed …))` verbatim. These pin
/// the rule that no raw type ever reaches a user, including for codes this
/// build has never heard of.
final class ErrorPresentationTests: XCTestCase {
    private func remote(_ code: String, _ message: String = "boom") -> Error {
        RPCTransport.TransportError.remote(
            WireError(code: ErrorCode(wireValue: code), message: message, data: nil)
        )
    }

    func testARefusedTokenSaysWhatToDoAndIsFlaggedAsACredentialProblem() {
        let presented = presentedError(remote("AUTH_FAILED", "Invalid token"))

        XCTAssertTrue(presented.isCredentialRejection)
        XCTAssertEqual(presented.code, "AUTH_FAILED")
        XCTAssertTrue(presented.message.contains("token"))
        XCTAssertFalse(presented.message.contains("WireError"))
        XCTAssertFalse(presented.message.contains("NessyAgentKit"))
    }

    func testAnUnknownCodeStillGetsASentenceAndKeepsTheCodeForSupport() {
        // A server newer than this app. The generic advice is the point; the
        // code is what makes a bug report actionable.
        let presented = presentedError(remote("SOME_FUTURE_CODE"))

        XCTAssertEqual(presented.code, "SOME_FUTURE_CODE")
        XCTAssertFalse(presented.isCredentialRejection)
        XCTAssertFalse(presented.message.isEmpty)
        XCTAssertFalse(presented.message.contains("SOME_FUTURE_CODE"))
        XCTAssertFalse(presented.message.contains("WireError"))
    }

    func testAnUnreachableServerReadsAsUnreachableRatherThanAsAnAuthProblem() {
        let presented = presentedError(RPCTransport.TransportError.notConnected)

        XCTAssertFalse(presented.isCredentialRejection)
        XCTAssertFalse(presented.message.contains("TransportError"))
    }

    func testABrowserToolWithoutADesktopExplainsThatADesktopIsNeeded() {
        let presented = presentedError(remote("BROWSER_NO_CAPABLE_CLIENT"))

        XCTAssertEqual(presented.code, "BROWSER_NO_CAPABLE_CLIENT")
        XCTAssertTrue(presented.message.lowercased().contains("desktop"))
    }

    func testANonTransportErrorNeverLeaksItsTypeName() {
        struct SomeInternalFailure: Error {}
        let presented = presentedError(SomeInternalFailure())

        XCTAssertFalse(presented.message.contains("SomeInternalFailure"))
        XCTAssertFalse(presented.message.isEmpty)
    }
}

/// P3.358 — the eight codes the mirror did not know. Every one of them decoded
/// to `.unknown` and rendered the generic sentence, and nothing on either side
/// of the wire said so: `scripts/ios-wire-enum-parity.ts` could not see
/// `ErrorCode` at all, because discovery required a `String` raw value and a
/// case carrying an associated value forbids one.
///
/// These assert the USER-VISIBLE half. The list half is asserted on the
/// TypeScript side deliberately — `swift test` runs in CI only under
/// `changes: apps/ios/**`, so a commit that adds a code to `protocol/types.ts`
/// and nothing else would never run this file.
extension ErrorPresentationTests {
    /// The generic fallback, quoted once so a test cannot silently start
    /// asserting equality against the very sentence it exists to rule out.
    private var genericSentence: String {
        presentedError(remote("A_CODE_NO_BUILD_WILL_EVER_KNOW")).message
    }

    func testThePolicyRefusalsSayItWasAPolicyRatherThanAMalfunction() {
        // These two exist SO THAT they can be translated (P2.464). A refusal a
        // Russian-locale user reads as a malfunction is the failure they were
        // minted to prevent, so the generic sentence is the wrong answer for
        // them specifically — not merely a vague one.
        for code in ["BROWSER_MANAGED_DISABLED", "MODEL_RESTRICTED_BY_POLICY"] {
            let presented = presentedError(remote(code))

            XCTAssertEqual(presented.code, code)
            XCTAssertNotEqual(presented.message, genericSentence, "\(code) still falls to the generic sentence")
            XCTAssertTrue(
                presented.message.lowercased().contains("policy"),
                "\(code) should name the policy as the cause: \(presented.message)"
            )
        }
    }

    func testEveryRuntimeSwitchRefusalSaysWhichPreconditionFailed() {
        // Six refusals, six different next steps — which is why the server
        // spends six codes on them instead of one.
        let refusals = [
            "SESSION_BUSY",
            "CONNECTION_NOT_SWITCHABLE",
            "CONNECTION_IN_USE",
            "WORKTREE_EXIT_UNAVAILABLE",
            "WORKTREE_DIRTY",
            "RUNTIME_UNHOSTABLE",
        ]
        var sentences: Set<String> = []
        for code in refusals {
            let presented = presentedError(remote(code))

            XCTAssertEqual(presented.code, code)
            XCTAssertNotEqual(presented.message, genericSentence, "\(code) still falls to the generic sentence")
            XCTAssertFalse(presented.isCredentialRejection, "\(code) is not a credential problem")
            sentences.insert(presented.message)
        }
        // Six codes, six sentences. The one sentence that IS shared is shared
        // with `SESSION_NOT_IDLE`, which is not in this list — asserted
        // separately below so the count above stays a clean "no two of these
        // read alike".
        XCTAssertEqual(sentences.count, refusals.count, "two refusals with different next steps read the same: \(sentences)")
        XCTAssertEqual(
            presentedError(remote("SESSION_BUSY")).message,
            presentedError(remote("SESSION_NOT_IDLE")).message,
            "SESSION_BUSY and SESSION_NOT_IDLE share one sentence on purpose"
        )
    }

    func testTheNewCodesDecodeToThemselvesRatherThanToUnknown() {
        // The half a presentation test cannot see on its own: a code that round
        // trips through `.unknown` would still carry the right `code` string
        // while matching no `case` in `presented(_:)`.
        for code in [
            "BROWSER_MANAGED_DISABLED", "MODEL_RESTRICTED_BY_POLICY", "SESSION_BUSY",
            "CONNECTION_NOT_SWITCHABLE", "CONNECTION_IN_USE", "WORKTREE_EXIT_UNAVAILABLE",
            "WORKTREE_DIRTY", "RUNTIME_UNHOSTABLE", "project-folder-identity-changed",
        ] {
            XCTAssertNotEqual(ErrorCode(wireValue: code), .unknown(code), "\(code) is not in the mirror")
            XCTAssertEqual(ErrorCode(wireValue: code).wireValue, code, "\(code) does not round trip")
        }
    }

    func testTheTwoBrowserDenialsSayWhichRefusalItWasAndDifferFromEachOther() {
        // P6.723 — the same shape as the eight above, two rows later. Separate
        // codes because the next step differs: the debugger may be off for the
        // whole server, whereas a navigation refusal is about THIS site not
        // being approved. Two codes that read alike would be one code.
        let cdp = presentedError(remote("BROWSER_CDP_DENIED"))
        let origin = presentedError(remote("BROWSER_ORIGIN_DENIED"))

        for presented in [cdp, origin] {
            XCTAssertNotEqual(presented.message, genericSentence, "\(presented.code ?? "?") still falls to the generic sentence")
            XCTAssertFalse(presented.isCredentialRejection)
        }
        XCTAssertEqual(cdp.code, "BROWSER_CDP_DENIED")
        XCTAssertEqual(origin.code, "BROWSER_ORIGIN_DENIED")
        XCTAssertNotEqual(cdp.message, origin.message, "the two browser denials read alike")
        // The half a presentation test cannot see on its own: a code round
        // tripping through `.unknown` still carries the right `code` string
        // while matching no `case` in `presented(_:)`.
        for code in ["BROWSER_CDP_DENIED", "BROWSER_ORIGIN_DENIED"] {
            XCTAssertNotEqual(ErrorCode(wireValue: code), .unknown(code), "\(code) is not in the mirror")
        }
    }

    func testTheGatewayOnlyRefusalIsExplainedRatherThanGeneric() {
        // P6.498 — an operator that requires the built-in gateway sign-in
        // refuses a personal-key or BYO connection. The same shape as the ten
        // above: a policy refusal the user can act on, so falling to the
        // generic sentence would read as a malfunction.
        let presented = presentedError(remote("CONNECTION_GATEWAY_ONLY"))

        XCTAssertEqual(presented.code, "CONNECTION_GATEWAY_ONLY")
        XCTAssertNotEqual(presented.message, genericSentence, "CONNECTION_GATEWAY_ONLY still falls to the generic sentence")
        XCTAssertFalse(presented.isCredentialRejection)
        XCTAssertNotEqual(ErrorCode(wireValue: "CONNECTION_GATEWAY_ONLY"), .unknown("CONNECTION_GATEWAY_ONLY"), "CONNECTION_GATEWAY_ONLY is not in the mirror")
        XCTAssertEqual(ErrorCode(wireValue: "CONNECTION_GATEWAY_ONLY").wireValue, "CONNECTION_GATEWAY_ONLY", "CONNECTION_GATEWAY_ONLY does not round trip")
    }

    func testTheProjectFolderIdentityRefusalIsExplainedRatherThanGeneric() {
        // UA12.149 — the server refuses to start a session in a project whose
        // stored folder no longer has the identity that was bound, rather than
        // start it somewhere else. The same shape as the eleven above: the
        // user can act on it (re-link the folder), so the generic sentence
        // would read as a malfunction. The wire value breaks the list's
        // SCREAMING_SNAKE convention on purpose — asserted verbatim.
        let presented = presentedError(remote("project-folder-identity-changed"))

        XCTAssertEqual(presented.code, "project-folder-identity-changed")
        XCTAssertNotEqual(presented.message, genericSentence, "project-folder-identity-changed still falls to the generic sentence")
        XCTAssertFalse(presented.isCredentialRejection)
        XCTAssertTrue(presented.message.lowercased().contains("folder"), "\(presented.message) should name the folder")
        XCTAssertNotEqual(ErrorCode(wireValue: "project-folder-identity-changed"), .unknown("project-folder-identity-changed"), "project-folder-identity-changed is not in the mirror")
        XCTAssertEqual(ErrorCode(wireValue: "project-folder-identity-changed").wireValue, "project-folder-identity-changed", "project-folder-identity-changed does not round trip")
    }

    func testAnUnheardOfCodeStillFallsToTheGenericSentence() {
        // The positive control for the three above: they assert "not generic",
        // which would also pass if the fallback itself had been broken.
        let presented = presentedError(remote("A_CODE_NO_BUILD_WILL_EVER_KNOW"))

        XCTAssertEqual(presented.code, "A_CODE_NO_BUILD_WILL_EVER_KNOW")
        XCTAssertEqual(presented.message, genericSentence)
        XCTAssertFalse(presented.message.isEmpty)
    }
}

/// F2 — a `wss://` dial against a plain-`ws` server. The system's own wording
/// ("An SSL error has occurred") sends the user hunting for a certificate
/// problem that does not exist, and the rig lost a cycle to exactly that.
extension ErrorPresentationTests {
    func testAPlainServerDialledOverTLSIsNamedAsSuchAndOffersTheDowngrade() {
        let presented = presentedError(URLError(.secureConnectionFailed))

        XCTAssertTrue(presented.isPlainServerBehindTLSDial)
        XCTAssertTrue(presented.message.contains("ws://"))
        // The cost of the downgrade must be stated, not implied.
        XCTAssertTrue(presented.message.lowercased().contains("unencrypted"))
    }

    func testAnUnreachableHostDoesNotOfferTheDowngrade() {
        // Offering "connect without TLS" on a failure it cannot fix would teach
        // the user to downgrade as a reflex.
        let presented = presentedError(URLError(.cannotConnectToHost))

        XCTAssertFalse(presented.isPlainServerBehindTLSDial)
    }

    func testARefusedTokenDoesNotOfferTheDowngrade() {
        let presented = presentedError(
            RPCTransport.TransportError.remote(WireError(code: ErrorCode(wireValue: "AUTH_FAILED"), message: "Invalid token", data: nil))
        )

        XCTAssertFalse(presented.isPlainServerBehindTLSDial)
    }
}
