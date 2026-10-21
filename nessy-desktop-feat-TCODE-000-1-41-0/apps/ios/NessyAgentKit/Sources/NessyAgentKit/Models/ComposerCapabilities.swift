import Foundation

/// The MVP-relevant slice of the desktop's `ComposerCapabilities` interface
/// (`packages/shared/src/protocol/dto.ts`), carried by the
/// `capabilities_changed` event.
///
/// Only the `connection` and `permissions` halves are modelled. The desktop
/// object also describes attachments, thinking levels and the slash-command
/// surface — none of which this client renders from the event — and every
/// field is decoded optionally so a server that grows the type does not break
/// the decode, which is the same forward-compatibility rule `SessionEvent`
/// follows for unknown `type`s.
public struct ComposerCapabilities: Codable, Equatable, Sendable {
    public let connection: ConnectionCapability?
    public let permissions: PermissionsCapability?

    public init(connection: ConnectionCapability? = nil, permissions: PermissionsCapability? = nil) {
        self.connection = connection
        self.permissions = permissions
    }

    /// F1.1069 — `{ modes, modeOptions }`: the modes this session's integration
    /// offers, which the desktop's picker, slash menu and SHIFT+TAB all read
    /// (`resolveComposerCapabilities`). Every Nessy runtime lists all of
    /// Nessy's modes; a Nestor Cloud session lists the cloud agent's own (Plan
    /// and Act) with their labels in `modeOptions`. The phone's picker renders
    /// from this through `PermissionMode.pickerEntries(for:)`.
    ///
    /// `modes` stays raw `String`s and never `[PermissionMode]`: one value this
    /// build does not know would throw, and take the capabilities object —
    /// and with it the whole session payload — down with it.
    public struct PermissionsCapability: Codable, Equatable, Sendable {
        public let modes: [String]?
        public let modeOptions: [ModeOption]?

        public init(modes: [String]? = nil, modeOptions: [ModeOption]? = nil) {
            self.modes = modes
            self.modeOptions = modeOptions
        }
    }

    /// One entry of `ComposerPermissionModeOption` (`dto.ts`): a local mode the
    /// server labels in its own words. `remoteModeId`/`iconMode` are not
    /// modelled — the server maps the local mode to the remote id itself.
    public struct ModeOption: Codable, Equatable, Sendable {
        public let mode: String?
        public let label: String?
        public let shortLabel: String?
        public let description: String?

        public init(mode: String?, label: String? = nil, shortLabel: String? = nil, description: String? = nil) {
            self.mode = mode
            self.label = label
            self.shortLabel = shortLabel
            self.description = description
        }
    }

    /// `{ switchable, activeRuntime }`. `switchable` is the server's own answer
    /// to "may this session move to another integration" — the desktop
    /// predicate is `provider !== 'nestor-cloud-agent'`, the `connection`
    /// field that `resolveComposerCapabilities` returns
    /// (`packages/shared/src/agent/backend/composer-capabilities.ts`).
    public struct ConnectionCapability: Codable, Equatable, Sendable {
        public let switchable: Bool
        public let activeRuntime: String

        public init(switchable: Bool, activeRuntime: String) {
            self.switchable = switchable
            self.activeRuntime = activeRuntime
        }
    }
}
