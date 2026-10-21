import Foundation

/// Mirrors `ToolDisplayMeta` in `packages/core/src/types/message.ts`: the
/// display metadata the host embeds on a tool call — on the `tool_start` event
/// and on the stored transcript `Message` alike.
///
/// `iconDataUrl` is not modelled: the phone draws its own tool glyph, and an
/// unmodelled key is ignored by the decoder rather than failing it.
public struct ToolDisplayMeta: Codable, Equatable, Sendable {
    /// Human-readable name (e.g. "Spawn Session", "Linear").
    public var displayName: String
    /// Brief description of what the tool does.
    public var toolDescription: String?
    /// `skill` | `source` | `native` | `mcp`, kept as the wire string so a
    /// category added later decodes instead of failing.
    public var category: String?

    private enum CodingKeys: String, CodingKey {
        case displayName
        case toolDescription = "description"
        case category
    }

    public init(displayName: String, toolDescription: String? = nil, category: String? = nil) {
        self.displayName = displayName
        self.toolDescription = toolDescription
        self.category = category
    }

    /// F1.436 — the name a tool row shows, in the desktop's order
    /// (`formatToolDisplay`, `packages/ui/src/components/chat/TurnCard.tsx`):
    ///
    /// 1. with the host's meta: an MCP tool of a SOURCE shows `<source>: <tool>`;
    ///    a native tool the model named (`toolDisplayName`) shows that name; any
    ///    other tool shows the meta's `displayName`;
    /// 2. without meta: the model's `toolDisplayName`, else the wire name.
    ///
    /// Not ported, and stated rather than hidden: the desktop's Bash icon/action
    /// merge ("Git: Status") and its skill-slug fallback for legacy sessions —
    /// both need the icon registry and the tool input, which the phone does not
    /// carry. A Bash row here shows the model's name or "Bash".
    public static func title(toolName: String?, toolDisplayName: String?, toolDisplayMeta: ToolDisplayMeta?) -> String {
        let named = toolDisplayName.flatMap { $0.isEmpty ? nil : $0 }
        if let meta = toolDisplayMeta, !meta.displayName.isEmpty {
            if meta.category == "source", let toolName, let slug = mcpToolSlug(toolName) {
                return "\(meta.displayName): \(slug)"
            }
            if meta.category == "native", let named { return named }
            return meta.displayName
        }
        if let named { return named }
        if let toolName, !toolName.isEmpty { return toolName }
        return "Tool"
    }

    /// The tool half of an MCP wire name, `mcp__<server>__<tool>`; the pooled
    /// `mcp__sources__<server>__<tool>` form skips the pool segment. Mirrors
    /// `parseMcpToolName` in `packages/ui/src/components/chat/mcp-tool-name.ts`.
    static func mcpToolSlug(_ name: String) -> String? {
        guard name.hasPrefix("mcp__") else { return nil }
        let parts = name.components(separatedBy: "__")
        guard parts.count >= 3 else { return nil }
        if parts[1] == "sources", parts.count >= 4, !parts[2].isEmpty {
            return parts[3...].joined(separator: "__")
        }
        return parts[2...].joined(separator: "__")
    }
}

extension ChatMessage {
    /// F1.436 — the name this tool row shows; see `ToolDisplayMeta.title`.
    public var toolDisplayTitle: String {
        ToolDisplayMeta.title(toolName: toolName, toolDisplayName: toolDisplayName, toolDisplayMeta: toolDisplayMeta)
    }
}
