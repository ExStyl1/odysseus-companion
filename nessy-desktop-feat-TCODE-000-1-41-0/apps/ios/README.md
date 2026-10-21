<!-- apps/ios/README.md -->
# Craft Agents — iOS/iPadOS client

This directory requires macOS + Xcode 16+ (iOS 18 SDK) + [XcodeGen](https://github.com/yonaskolb/XcodeGen).
It cannot be built or tested on Linux.

## Layout
- `NessyAgentKit/` — pure-Swift protocol/transport/model layer (SwiftPM package, no UIKit). Test with `swift test`.
- `NessyMobile/` — SwiftUI app target. Generate the Xcode project with:

  ```bash
  brew install xcodegen
  cd apps/ios/NessyMobile && xcodegen generate
  open NessyMobile.xcodeproj
  ```

  The generated `.xcodeproj` is gitignored — `project.yml` is the source of truth.
