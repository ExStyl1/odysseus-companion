import SwiftUI

/// NESSY DEVIATION (F13): the theme system reads the DESKTOP's token format.
///
/// The desktop already stores themes as token JSON (`<config>/themes/*.json`),
/// which is exactly the shape a theme engine consumes. Porting those palettes
/// into Swift one at a time would be the anti-goal: adding a theme would mean
/// shipping an app build. Here, a theme is a file — the same file the desktop
/// reads — so the two products cannot drift, and the stretch goal (fetching the
/// server's theme list over RPC) becomes a data change, not a code change.
struct ThemeTokens: Decodable, Equatable, Identifiable {
    /// Top-level values are the LIGHT palette; `dark` overrides them.
    struct Palette: Decodable, Equatable {
        let background: String
        let foreground: String
        let accent: String
        let info: String?
        let success: String?
        let destructive: String?
    }

    let name: String
    let description: String?
    let background: String
    let foreground: String
    let accent: String
    let info: String?
    let success: String?
    let destructive: String?
    let dark: Palette?

    /// Stable across launches: the file name, not the display name.
    var id: String = ""

    private enum CodingKeys: String, CodingKey {
        case name, description, background, foreground, accent, info, success, destructive, dark
    }

    var light: Palette {
        Palette(
            background: background, foreground: foreground, accent: accent,
            info: info, success: success, destructive: destructive
        )
    }

    func palette(for scheme: ColorScheme) -> Palette {
        scheme == .dark ? (dark ?? light) : light
    }
}

extension Color {
    /// `#rgb`, `#rrggbb`, `#rrggbbaa`. Returns `nil` rather than a wrong colour:
    /// a malformed token must fall back to the built-in value, not render black
    /// text on a black background.
    init?(themeToken raw: String) {
        var hex = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if hex.hasPrefix("#") { hex.removeFirst() }
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count == 6 || hex.count == 8, let value = UInt64(hex, radix: 16) else { return nil }
        let hasAlpha = hex.count == 8
        let r = Double((value >> (hasAlpha ? 24 : 16)) & 0xFF) / 255
        let g = Double((value >> (hasAlpha ? 16 : 8)) & 0xFF) / 255
        let b = Double((value >> (hasAlpha ? 8 : 0)) & 0xFF) / 255
        let a = hasAlpha ? Double(value & 0xFF) / 255 : 1
        self.init(.sRGB, red: r, green: g, blue: b, opacity: a)
    }
}

@Observable
@MainActor
final class NessyThemeStore {
    static let shared = NessyThemeStore()

    private(set) var available: [ThemeTokens] = []
    /// Dark is the default (owner, 2026-08-09).
    var colorScheme: ColorScheme = .dark {
        didSet { UserDefaults.standard.set(colorScheme == .dark, forKey: Self.schemeKey) }
    }
    var selectedId: String? {
        didSet { UserDefaults.standard.set(selectedId, forKey: Self.themeKey) }
    }

    private static let themeKey = "nessy.theme.id"
    private static let schemeKey = "nessy.theme.dark"

    private init() {
        if UserDefaults.standard.object(forKey: Self.schemeKey) != nil {
            colorScheme = UserDefaults.standard.bool(forKey: Self.schemeKey) ? .dark : .light
        }
        selectedId = UserDefaults.standard.string(forKey: Self.themeKey)
        available = Self.loadBundledThemes()
    }

    var selected: ThemeTokens? {
        guard let selectedId else { return nil }
        return available.first { $0.id == selectedId }
    }

    /// Every `.json` under `Themes/` in the bundle. Adding a theme is adding a
    /// file — no Swift change, which is the whole point of the format.
    private static func loadBundledThemes() -> [ThemeTokens] {
        let urls = Bundle.main.urls(forResourcesWithExtension: "json", subdirectory: "Themes") ?? []
        return urls.compactMap { url in
            guard let data = try? Data(contentsOf: url),
                  var tokens = try? JSONDecoder().decode(ThemeTokens.self, from: data)
            else { return nil }  // A broken file is skipped, never fatal.
            tokens.id = url.deletingPathExtension().lastPathComponent
            return tokens
        }.sorted { $0.name < $1.name }
    }
}

/// The colours the app draws with. Falls back to the built-in palette whenever
/// a theme is absent or a token is malformed, so a bad file degrades to the
/// shipped look rather than to an unreadable screen.
enum NessyTheme {
    @MainActor
    private static var palette: ThemeTokens.Palette? {
        let store = NessyThemeStore.shared
        return store.selected?.palette(for: store.colorScheme)
    }

    @MainActor
    static var accent: Color {
        palette.flatMap { Color(themeToken: $0.accent) } ?? Color(red: 0.48, green: 0.38, blue: 0.76)
    }

    @MainActor
    static var accentGradient: LinearGradient {
        LinearGradient(
            colors: [accent, accent.opacity(0.72)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    @MainActor
    static var cardBackground: Color {
        Color(uiColor: .secondarySystemGroupedBackground)
    }

    @MainActor
    static var hairline: Color {
        Color.primary.opacity(0.08)
    }

    static let chatMaxWidth: CGFloat = 760
}
