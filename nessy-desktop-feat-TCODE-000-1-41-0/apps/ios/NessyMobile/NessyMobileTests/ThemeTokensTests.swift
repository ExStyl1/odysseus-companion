import XCTest
import SwiftUI
@testable import NessyMobile

/// F13 — the engine is the point, not the palettes. These pin the desktop's
/// token format and the failure behaviour: a bad file must degrade to the
/// shipped look, never to an unreadable screen.
final class ThemeTokensTests: XCTestCase {
    private let oneDarkPro = """
    {
      "name": "One Dark Pro",
      "description": "Atom-inspired, balanced contrast",
      "background": "#fafafa",
      "foreground": "#383a42",
      "accent": "#4078f2",
      "dark": { "background": "#282c34", "foreground": "#abb2bf", "accent": "#61afef" }
    }
    """

    func testDecodesTheDesktopTokenFormat() throws {
        let tokens = try JSONDecoder().decode(ThemeTokens.self, from: Data(oneDarkPro.utf8))

        XCTAssertEqual(tokens.name, "One Dark Pro")
        XCTAssertEqual(tokens.accent, "#4078f2")
        XCTAssertEqual(tokens.dark?.accent, "#61afef")
    }

    func testTopLevelIsLightAndTheDarkObjectOverridesIt() throws {
        let tokens = try JSONDecoder().decode(ThemeTokens.self, from: Data(oneDarkPro.utf8))

        XCTAssertEqual(tokens.palette(for: .light).background, "#fafafa")
        XCTAssertEqual(tokens.palette(for: .dark).background, "#282c34")
    }

    func testAThemeWithoutADarkPaletteFallsBackToLightRatherThanFailing() throws {
        let json = "{\"name\":\"Light Only\",\"background\":\"#fff\",\"foreground\":\"#000\",\"accent\":\"#f00\"}"
        let tokens = try JSONDecoder().decode(ThemeTokens.self, from: Data(json.utf8))

        XCTAssertEqual(tokens.palette(for: .dark).accent, "#f00")
    }

    func testParsesEveryHexShapeTheFormatUses() {
        XCTAssertNotNil(Color(themeToken: "#4078f2"))
        XCTAssertNotNil(Color(themeToken: "4078f2"))
        XCTAssertNotNil(Color(themeToken: "#fff"))
        XCTAssertNotNil(Color(themeToken: "#4078f2ff"))
    }

    func testAMalformedTokenReturnsNilSoTheCallerCanFallBack() {
        // Returning a wrong colour would render black text on a black
        // background; nil lets the caller keep the shipped palette.
        XCTAssertNil(Color(themeToken: "not-a-colour"))
        XCTAssertNil(Color(themeToken: "#12345"))
        XCTAssertNil(Color(themeToken: ""))
    }

    func testTheBundledThemesSurviveIntoTheAppBundleUnderThemes() throws {
        // Adding a theme must be adding a FILE. Xcode flattens a plain group,
        // which leaves `subdirectory: "Themes"` matching nothing and the engine
        // silently inert — measured, which is why `Themes/` is a folder
        // reference in project.yml.
        let urls = try XCTUnwrap(Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: "Themes"))

        XCTAssertFalse(urls.isEmpty, "Themes/ is not in the app bundle — the engine would load nothing")
        let decoded = urls.compactMap { url -> ThemeTokens? in
            guard let data = try? Data(contentsOf: url) else { return nil }
            return try? JSONDecoder().decode(ThemeTokens.self, from: data)
        }
        XCTAssertEqual(decoded.count, urls.count, "a bundled theme failed to decode")
        XCTAssertTrue(decoded.contains { $0.dark != nil }, "at least one bundled theme must carry a dark palette")
    }
}
