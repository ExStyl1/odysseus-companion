// apps/ios/NessyAgentKit/Package.swift
// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "NessyAgentKit",
    platforms: [
        .iOS(.v18),
        .macOS(.v15), // enables `swift test` on macOS CI/dev machines without booting a simulator
    ],
    products: [
        .library(name: "NessyAgentKit", targets: ["NessyAgentKit"]),
    ],
    targets: [
        .target(name: "NessyAgentKit"),
        .testTarget(name: "NessyAgentKitTests", dependencies: ["NessyAgentKit"]),
    ]
)
