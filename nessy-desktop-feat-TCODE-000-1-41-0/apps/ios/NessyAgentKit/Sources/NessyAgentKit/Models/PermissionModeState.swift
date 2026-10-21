import Foundation

/// Mirrors the return of `sessions:getPermissionModeState` in
/// `packages/server-core/src/sessions/SessionManager.ts`.
public struct PermissionModeState: Codable, Equatable, Sendable {
    public let permissionMode: String
    public let previousPermissionMode: String?
    public let transitionDisplay: String?
    public let modeVersion: Int
    public let changedAt: String
    public let changedBy: String
    /// F1.1165 — the mode a new session in this workspace starts in (the menu's "Default" badge). A raw wire id like
    /// the fields above; absent from an older server.
    public let workspaceDefaultPermissionMode: String?

    public init(
        permissionMode: String,
        previousPermissionMode: String? = nil,
        transitionDisplay: String? = nil,
        modeVersion: Int,
        changedAt: String,
        changedBy: String,
        workspaceDefaultPermissionMode: String? = nil
    ) {
        self.permissionMode = permissionMode
        self.previousPermissionMode = previousPermissionMode
        self.transitionDisplay = transitionDisplay
        self.modeVersion = modeVersion
        self.changedAt = changedAt
        self.changedBy = changedBy
        self.workspaceDefaultPermissionMode = workspaceDefaultPermissionMode
    }
}

/// NESSY DEVIATION (M1). Upstream carried the PRE-MIGRATION vocabulary —
/// `safe`/`ask`/`allow-all`, three modes. This fork moved to Claude's vocabulary
/// on 2026-07-31 (`packages/shared/src/agent/mode-types.ts`), and since F1.1069
/// (2026-09-29, the owner's mode unification) it is exactly Claude Code's six:
/// Nessy's own `explore` is retired.
///
/// Two consequences, and the first is why this could not be left alone: the
/// server SENDS the canonical spellings, and a Swift raw-value `Codable` enum
/// throws on a value it does not know. A device on the old enum would fail to
/// decode `"explore"` — and with it the whole payload carrying the mode. So
/// every wire field that carries a mode stays a raw `String`
/// (`Session.permissionMode`, `PermissionModeState.permissionMode`, the
/// `permission_mode_changed` event, `ComposerCapabilities.permissions.modes`),
/// and this enum is what a raw value RESOLVES to, through `from(rawId:)`.
///
/// The legacy spellings stay READABLE forever, exactly as the desktop's own
/// alias table keeps them (`ask → default`, `allow-all → bypassPermissions`,
/// and since F1.1069 `explore → plan` and `safe → plan`: an older server still
/// reports a session in `explore`, and it reads as Plan). They are never
/// written back.
public enum PermissionMode: String, Codable, Sendable, CaseIterable {
    case dontAsk
    case plan
    case `default`
    case acceptEdits
    case auto
    case bypassPermissions

    /// Least-to-most permissive, mirroring `PERMISSION_MODE_ORDER` — the
    /// STRICTNESS order. Never the order a picker renders; that is `pickerOrder`.
    public static var allCases: [PermissionMode] {
        [.dontAsk, .plan, .default, .acceptEdits, .auto, .bypassPermissions]
    }

    /// F1.1069 — the picker's order, which is Claude Desktop's (owner spec
    /// 2026-09-28): Auto, Manual, Accept edits, Plan, Bypass permissions. A UI
    /// order only.
    ///
    /// `dontAsk` is absent on purpose, as on the desktop (`PICKER_HIDDEN_MODES`
    /// in the renderer's `composer-permission-modes.ts`): it stays a working
    /// mode for automations, unattended runs and config files, and a session
    /// that holds it is SHOWN as "Don't ask" — it is just never offered.
    public static let pickerOrder: [PermissionMode] = [.auto, .default, .acceptEdits, .plan, .bypassPermissions]

    /// NESSY DEVIATION (F8): the modes a REMOTE device may set.
    ///
    /// `bypassPermissions` is absent because the server refuses it from a
    /// non-local client — a phone in a pocket, on a network someone else runs,
    /// must not be able to un-gate a workstation. The picker still LISTS it
    /// (F1.1069: the list matches the desktop's) but does not offer it. This
    /// list is NOT the enforcement. The enforcement is
    /// `packages/server-core/src/handlers/rpc/sessions.ts` → `setPermissionMode`,
    /// because a hidden control is a suggestion and the client is the piece an
    /// attacker can replace.
    public static var settableFromRemoteDevice: [PermissionMode] {
        allCases.filter { $0 != .bypassPermissions }
    }

    /// Permanent read-path aliases. Never emitted.
    static let legacy: [String: PermissionMode] = [
        "explore": .plan,
        "safe": .plan,
        "ask": .default,
        "allow-all": .bypassPermissions,
        "allowall": .bypassPermissions,
        "execute": .bypassPermissions,
        "ask-to-edit": .default,
        "asktoedit": .default,
        "manual": .default,
        "automatic": .auto,
    ]

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let mode = PermissionMode(rawValue: raw) ?? PermissionMode.legacy[raw.lowercased()] else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "Unknown permission mode \(raw)",
            ))
        }
        self = mode
    }

    /// User-facing label — Claude Code's own names (permission-modes.md,
    /// "Available modes"), the same the desktop shows. Localized through the
    /// app's `Localizable.strings`.
    public var displayName: String {
        switch self {
        case .dontAsk: return String(localized: "Don't ask")
        case .plan: return String(localized: "Plan")
        case .default: return String(localized: "Manual")
        case .acceptEdits: return String(localized: "Accept edits")
        case .auto: return String(localized: "Auto")
        case .bypassPermissions: return String(localized: "Bypass permissions")
        }
    }

    /// The composer capsule's label, where the full name of one mode does not
    /// fit beside the model button on a phone.
    public var shortDisplayName: String {
        self == .bypassPermissions ? String(localized: "Bypass") : displayName
    }

    /// One line under the name in the picker — the owner spec's runtime-neutral
    /// wording of Claude Desktop's.
    public var detail: String {
        switch self {
        case .dontAsk: return String(localized: "Never asks; runs only pre-approved tools")
        case .plan: return String(localized: "Create a plan before making changes")
        case .default: return String(localized: "Always ask before making changes")
        case .acceptEdits: return String(localized: "Automatically accept all file edits")
        case .auto: return String(localized: "Handles permission decisions for you")
        case .bypassPermissions: return String(localized: "Accepts all permissions")
        }
    }

    /// Maps a raw wire id (which may be `safe`/`ask`/`allow-all`/`explore`) to a mode.
    public static func from(rawId: String?) -> PermissionMode? {
        guard let rawId else { return nil }
        // NESSY DEVIATION (M1): resolve legacy spellings here too, not only in
        // the decoder. A session persisted before the 2026-07-31 migration
        // carries `safe`/`ask`/`allow-all`, and `init(rawValue:)` alone would
        // silently fall back to a default mode — showing the user a mode their
        // session is not in.
        return PermissionMode(rawValue: rawId) ?? PermissionMode.legacy[rawId.lowercased()]
    }

    /// F1.1069 — the rows of the device's mode picker, resolved from what the
    /// SERVER says this session's integration offers
    /// (`ComposerCapabilities.permissions`), the list the desktop reads too.
    ///
    /// - When the server names the modes in its own words (`modeOptions` —
    ///   today only a Nestor Cloud session, whose Plan and Act come from the
    ///   cloud agent's card), those modes are the whole list, in the server's
    ///   order and under the server's labels. Nessy's own modes are not added.
    /// - Otherwise the list is `pickerOrder`, narrowed to the modes the server
    ///   lists when it lists any.
    ///
    /// Either way `dontAsk` is never offered, a value this build cannot resolve
    /// is skipped rather than offered (it cannot be sent), and an old server's
    /// `explore` folds into Plan. A list that resolves to nothing falls back to
    /// `pickerOrder`, as the desktop's `getVisibleComposerPermissionModes` does.
    ///
    /// F1.1165 — each of OUR rows carries the desktop's badges (`resolvePermissionModeMenuDecorations`, F1.1052):
    /// Recommended on Auto, Default on `defaultMode` (the workspace's start mode; `nil` draws none rather than
    /// guessing). A row the server labelled itself (Nestor Cloud) gets neither.
    public static func pickerEntries(
        for permissions: ComposerCapabilities.PermissionsCapability?,
        defaultMode: PermissionMode? = nil
    ) -> [PermissionModePickerEntry] {
        let options = permissions?.modeOptions ?? []
        var supplied: [PermissionMode] = []
        for raw in permissions?.modes ?? options.compactMap(\.mode) {
            guard let mode = from(rawId: raw), !supplied.contains(mode) else { continue }
            supplied.append(mode)
        }
        var modes = options.isEmpty
            ? pickerOrder.filter { supplied.isEmpty || supplied.contains($0) }
            : supplied.filter { $0 != .dontAsk }
        if modes.isEmpty { modes = pickerOrder }
        let settable = settableFromRemoteDevice
        return modes.map { mode in
            let option = options.first { from(rawId: $0.mode) == mode }
            return PermissionModePickerEntry(
                mode: mode,
                title: option?.label ?? mode.displayName,
                detail: option?.description ?? mode.detail,
                isSelectable: settable.contains(mode),
                isRecommended: option == nil && mode == .auto,
                isDefault: option == nil && defaultMode != nil && mode == defaultMode
            )
        }
    }

    /// F1.1069 — what the composer capsule says for the session's current mode.
    ///
    /// `nil` only when there is no mode at all (not loaded yet, or the read
    /// failed) — P6.372's third state, which the view renders as "Mode
    /// unknown" rather than guessing the safe answer. A value this build cannot
    /// resolve is shown by its RAW name, never dropped and never mistaken for a
    /// known mode. A mode the server labels itself (Nestor Cloud's Act) reads
    /// by that label.
    public static func currentLabel(
        rawId: String?,
        permissions: ComposerCapabilities.PermissionsCapability?
    ) -> String? {
        guard let rawId, !rawId.isEmpty else { return nil }
        guard let mode = from(rawId: rawId) else { return rawId }
        let option = permissions?.modeOptions?.first { from(rawId: $0.mode) == mode }
        return option?.shortLabel ?? option?.label ?? mode.shortDisplayName
    }
}

/// F1.1069 — one row of the device's mode picker (`PermissionMode.pickerEntries`).
public struct PermissionModePickerEntry: Equatable, Sendable, Identifiable {
    public let mode: PermissionMode
    public let title: String
    public let detail: String
    /// `false` for a mode the server refuses from a remote device (F8): it is
    /// listed, so the menu matches the desktop's, and not offered.
    public let isSelectable: Bool
    /// F1.1165 — Claude Desktop's "Recommended" badge (Auto, on our own rows).
    public let isRecommended: Bool
    /// F1.1165 — the "Default" badge: the mode a new session in this workspace starts in.
    public let isDefault: Bool

    public var id: PermissionMode { mode }

    public init(mode: PermissionMode, title: String, detail: String, isSelectable: Bool, isRecommended: Bool = false, isDefault: Bool = false) {
        self.mode = mode
        self.title = title
        self.detail = detail
        self.isSelectable = isSelectable
        self.isRecommended = isRecommended
        self.isDefault = isDefault
    }
}
