import XCTest
@testable import NessyAgentKit

final class WireErrorTests: XCTestCase {
    func testDecodesKnownErrorCode() throws {
        let json = Data("""
        {"code": "AUTH_FAILED", "message": "Invalid token"}
        """.utf8)
        let error = try JSONDecoder().decode(WireError.self, from: json)
        XCTAssertEqual(error.code, .authFailed)
        XCTAssertEqual(error.message, "Invalid token")
        XCTAssertNil(error.data)
    }

    func testTheBrowserDenialCodesAreKnownAndRoundTrip() throws {
        // P6.723. Both arrived with P6.536 and neither reached this mirror, so
        // both decoded to `.unknown` and the device showed the generic
        // sentence — the outcome a per-reason code exists to prevent. The
        // round trip is the half a decode test alone cannot see: a case added
        // to `wireMap` and not to `wireValue` compiles and encodes wrongly.
        for code in ["BROWSER_CDP_DENIED", "BROWSER_ORIGIN_DENIED"] {
            let error = try JSONDecoder().decode(
                WireError.self,
                from: Data(#"{"code": "\#(code)", "message": "m"}"#.utf8)
            )
            XCTAssertNotEqual(error.code, .unknown(code), "\(code) is not in the mirror")
            XCTAssertEqual(error.code.wireValue, code, "\(code) does not round trip")
        }
    }

    func testUnknownErrorCodeDecodesToUnknownCase() throws {
        // Forward-compat: the server may add new codes; the client must not crash.
        let json = Data("""
        {"code": "SOME_FUTURE_CODE", "message": "future"}
        """.utf8)
        let error = try JSONDecoder().decode(WireError.self, from: json)
        XCTAssertEqual(error.code, .unknown("SOME_FUTURE_CODE"))
    }
}
