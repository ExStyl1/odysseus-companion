// apps/ios/NessyAgentKit/Tests/NessyAgentKitTests/SmokeTests.swift
import XCTest
@testable import NessyAgentKit

final class SmokeTests: XCTestCase {
    func testPackageBuilds() {
        XCTAssertEqual(NessyAgentKit.supportedProtocolVersion, "1.0")
    }
}
