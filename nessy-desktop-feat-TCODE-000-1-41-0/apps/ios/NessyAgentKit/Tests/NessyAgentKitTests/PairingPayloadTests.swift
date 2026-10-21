import XCTest
@testable import NessyAgentKit

/// F5 — must agree exactly with `packages/shared/src/pairing/pairing-url.ts`.
/// These are the same vectors that file's tests use.
final class PairingPayloadTests: XCTestCase {
    func testParsesURLTokenAndFingerprint() throws {
        let raw = "nessy://pair?url=wss%3A%2F%2F10.60.3.95%3A9101&token=abcdefghijklmnopqrstuvwxyz012345&fp=8B%3A50%3A60%3A88"
        let payload = try XCTUnwrap(PairingPayload(scanned: raw))

        XCTAssertEqual(payload.url.absoluteString, "wss://10.60.3.95:9101")
        XCTAssertEqual(payload.token, "abcdefghijklmnopqrstuvwxyz012345")
        XCTAssertEqual(payload.fingerprint?.value, "8B:50:60:88")
    }

    func testAFingerprintIsOptional() throws {
        let raw = "nessy://pair?url=ws%3A%2F%2F10.60.3.95%3A9101&token=t"
        let payload = try XCTUnwrap(PairingPayload(scanned: raw))

        XCTAssertNil(payload.fingerprint)
        XCTAssertEqual(payload.url.scheme, "ws")
    }

    func testATokenWithURLMetacharactersSurvives() throws {
        let raw = "nessy://pair?url=wss%3A%2F%2Fh%3A1&token=a%26b%3Dc%20d%2F%2B%25%3F%23"
        let payload = try XCTUnwrap(PairingPayload(scanned: raw))

        XCTAssertEqual(payload.token, "a&b=c d/+%?#")
    }

    func testRejectsCodesThatAreNotOurs() {
        // A camera sees a lot of QR codes.
        let rejected = [
            "hello world",
            "https://example.com/?url=x&token=y",
            "nessy://connect?url=wss://h:1&token=t",
            "nessy://pair?url=wss%3A%2F%2Fh%3A1",
            "nessy://pair?token=t",
            "nessy://pair?url=https%3A%2F%2Fh&token=t",
            "",
        ]

        for raw in rejected {
            XCTAssertNil(PairingPayload(scanned: raw), "should reject: \(raw)")
        }
    }
}
