import Foundation

extension RPCClient {
    /// `capabilities:getCatalog` — the Safe-capability projection.
    ///
    /// F3: this is what replaced the removed raw `skills:get`/`sources:get`
    /// routes, and it was already served to remote clients before this app
    /// asked for it. The context ref must name the same workspace the handshake
    /// carried, or the server answers `capability-context-workspace-mismatch`.
    public func getCapabilityCatalog(sessionId: String, workspaceId: String) async throws -> SafeCapabilityCatalog {
        let result = try await transport.request(
            channel: RPCChannels.Capabilities.getCatalog,
            args: [.object(["sessionId": .string(sessionId), "workspaceId": .string(workspaceId)])]
        )
        return try result.decoded()
    }

    /// `capabilities:getDetail` — summary, safe fields and resource references.
    /// Still no body and no absolute path: the projection is the boundary.
    public func getCapabilityDetail(
        sessionId: String,
        workspaceId: String,
        key: String
    ) async throws -> SafeCapabilityDetail {
        let result = try await transport.request(
            channel: RPCChannels.Capabilities.getDetail,
            args: [
                .object(["sessionId": .string(sessionId), "workspaceId": .string(workspaceId)]),
                .string(key),
            ]
        )
        return try result.decoded()
    }
}
