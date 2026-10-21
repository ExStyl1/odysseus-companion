import Foundation

/// NESSY DEVIATION (F3): the Safe-capability projection, as the server serves it.
///
/// The raw `skills:get` / `sources:get` list and detail routes were removed
/// DELIBERATELY by the Safe-capability migration, and re-adding them is a
/// stated failure. What replaced them is this projection: names, descriptions
/// and states — **no bodies, no secrets, and no absolute paths**. That last
/// omission is a decision, not an oversight, so nothing here reconstructs a
/// path even when one would be convenient to show.
public struct SafeCapabilitySummary: Codable, Equatable, Identifiable, Sendable {
    /// Opaque, stable, and the argument `capabilities:getDetail` expects.
    public let key: String
    /// `skill`, `mcp`, `source`, `agent`, `hook`, `permission`, `automation`,
    /// `prompt-command`, `app` — decoded as a string rather than an enum so a
    /// server that grows a new kind does not fail the whole catalog.
    public let kind: String
    public let logicalName: String?
    public let displayName: String?
    public let description: String?
    public let state: String?
    public let trustState: String?
    public let credentialState: String?
    public let readOnly: Bool?
    public let diagnosticCodes: [String]?

    public init(
        key: String, kind: String, logicalName: String?, displayName: String?, description: String?,
        state: String?, trustState: String?, credentialState: String?, readOnly: Bool?, diagnosticCodes: [String]?
    ) {
        self.key = key; self.kind = kind; self.logicalName = logicalName
        self.displayName = displayName; self.description = description; self.state = state
        self.trustState = trustState; self.credentialState = credentialState
        self.readOnly = readOnly; self.diagnosticCodes = diagnosticCodes
    }

    public var id: String { key }

    /// What to show in a list: the display name, else the logical name, else
    /// the key — never empty.
    public var title: String {
        displayName?.isEmpty == false ? displayName!
            : (logicalName?.isEmpty == false ? logicalName! : key)
    }
}

/// `capabilities:getDetail` — the summary plus whatever safe fields and
/// resource references the server chose to expose. `safeFields` is decoded
/// permissively: it is a projection whose shape is the server's to grow.
public struct SafeCapabilityDetail: Codable, Equatable, Sendable {
    public let summary: SafeCapabilitySummary
    public let safeFields: [String: JSONValue]?
    public let resources: [SafeCapabilityResource]?
}

public struct SafeCapabilityResource: Codable, Equatable, Identifiable, Sendable {
    public let id: String?
    public let name: String?
    public let kind: String?
    public let description: String?
}

/// `capabilities:getCatalog`.
public struct SafeCapabilityCatalog: Codable, Equatable, Sendable {
    public let capabilities: [SafeCapabilitySummary]

    /// Skills, in catalog order.
    public var skills: [SafeCapabilitySummary] {
        capabilities.filter { $0.kind == "skill" }
    }

    /// Sources: the source entries plus the MCP servers, which is what the
    /// desktop's Sources surface shows.
    public var sources: [SafeCapabilitySummary] {
        capabilities.filter { $0.kind == "source" || $0.kind == "mcp" }
    }
}
