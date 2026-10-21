import XCTest
@testable import NessyAgentKit

/// F1 — the trust policy for a self-signed server certificate. The dangerous
/// case is `changed`: an encrypted wire that accepts any certificate is open to
/// exactly the attacker a shared network has.
final class CertificateTrustTests: XCTestCase {
    private let a = CertificateFingerprint(value: "AA:BB:CC")
    private let b = CertificateFingerprint(value: "11:22:33")

    func testARealCertificateNeedsNoPinning() {
        // A server with a proper chain must not be harder to use than a
        // self-signed one.
        XCTAssertEqual(
            certificateTrustDecision(presented: a, pinned: nil, systemTrusted: true),
            .systemTrusted
        )
    }

    func testAnUnseenSelfSignedCertificateIsReportedForTheUserToConfirm() {
        XCTAssertEqual(
            certificateTrustDecision(presented: a, pinned: nil, systemTrusted: false),
            .unknown(a)
        )
    }

    func testThePinnedCertificateIsAccepted() {
        XCTAssertEqual(
            certificateTrustDecision(presented: a, pinned: a, systemTrusted: false),
            .pinned(a)
        )
    }

    func testAChangedCertificateIsReportedAsChangedRatherThanUnknown() {
        // Must NOT degrade to `.unknown`: that would re-ask the user and train
        // them to accept an interposer.
        XCTAssertEqual(
            certificateTrustDecision(presented: b, pinned: a, systemTrusted: false),
            .changed(expected: a, received: b)
        )
    }

    func testFingerprintComparisonIgnoresSeparatorsAndCase() {
        // The user compares a value read off a terminal with one on a phone.
        let fingerprint = CertificateFingerprint(value: "AA:BB:CC")

        XCTAssertTrue(fingerprint.matches("aa:bb:cc"))
        XCTAssertTrue(fingerprint.matches("AABBCC"))
        XCTAssertTrue(fingerprint.matches("aa bb cc"))
        XCTAssertFalse(fingerprint.matches("AA:BB:CD"))
    }

    func testTheFingerprintOfKnownBytesMatchesTheServersFormat() throws {
        // Uppercase hex, colon-separated, SHA-256 — the shape both the server
        // and `openssl x509 -fingerprint -sha256` print.
        let fingerprint = CertificateFingerprint(derBytes: Data([0x00]))

        XCTAssertEqual(
            fingerprint.value,
            "6E:34:0B:9C:FF:B3:7A:98:9C:A5:44:E6:BB:78:0A:2C:78:90:1D:3F:B3:37:38:76:85:11:A3:06:17:AF:A0:1D"
        )
    }

    func testASavedConnectionWithoutAFingerprintStillDecodes() throws {
        // An older pairing (plain ws, or a real certificate) must not break.
        let json = #"{"id":"3F2504E0-4F89-11D3-9A0C-0305E82C3301","name":"s","url":"ws://x:1","token":"t"}"#
        let connection = try JSONDecoder().decode(ServerConnection.self, from: Data(json.utf8))

        XCTAssertNil(connection.pinnedFingerprint)
    }
}
