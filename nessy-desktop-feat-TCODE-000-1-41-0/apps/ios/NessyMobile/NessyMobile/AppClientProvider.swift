// apps/ios/NessyMobile/NessyMobile/AppClientProvider.swift
import Foundation
import Observation
import NessyAgentKit

/// Owns the single `RPCClient` for the app's lifetime, established from the
/// most recently saved `ServerConnection`. Injected into the view hierarchy
/// so `SessionListViewModel`/`ChatViewModel` share one live connection
/// instead of each opening their own socket.
@Observable
@MainActor
final class AppClientProvider {
    private(set) var client: RPCClient?
    private(set) var connectionState: ConnectionState = .idle
    /// The workspace the active connection was established against. Used as the
    /// primary source when creating a new session so the "+" action never has to
    /// guess (fixes "No workspace available").
    private(set) var workspaceId: String?
    /// All workspaces available on the connected server (for the switcher).
    private(set) var workspaces: [Workspace] = []
    private(set) var lastError: String?
    /// NESSY DEVIATION (M5): set when the server rejected the SAVED credential.
    /// The Keychain outlives an app uninstall, so a dead token quietly logs the
    /// app straight past onboarding and parks it "offline" forever. Sitting on a
    /// credential the server has refused is not a network problem and must not
    /// be presented as one — the connection is dropped and the user is sent back
    /// to pairing.
    private(set) var savedCredentialRejected = false
    /// The wire code behind `lastError`, shown in small print. Never the type.
    private(set) var lastErrorCode: String?
    /// Changes whenever the provider replaces its underlying RPC client. Views
    /// use this to discard view models bound to a disconnected transport.
    private(set) var connectionRevision = 0
    private let store: ServerConnectionStore
    /// The connection currently in use, retained so we can reconnect with a
    /// different workspace id.
    private var connection: ServerConnection?

    /// NESSY DEVIATION (F16): which server this device is talking to.
    ///
    /// The phone stores exactly ONE paired connection, so this is a property of
    /// the app rather than of a row — there is no per-session machine to vary,
    /// and inventing one would be inventing a feature. The name is what pairing
    /// recorded (the host, unless the user gave it another), so it matches what
    /// they typed or scanned.
    var serverDisplayName: String? {
        guard let connection else { return nil }
        let name = connection.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { return name }
        return connection.url.host
    }

    init(store: ServerConnectionStore) {
        self.store = store
    }

    func connectToSavedServer() async {
        guard let connection = try? await store.mostRecent() else { return }
        self.connection = connection
        await connect(using: connection)
    }

    /// Switches the active workspace by reconnecting the transport with the new
    /// workspace id (the server scopes sessions to the handshake workspace) and
    /// persisting the choice on the saved connection.
    func switchWorkspace(to id: String) async {
        guard let existing = connection, existing.workspaceId != id else { return }
        let updated = ServerConnection(
            id: existing.id, name: existing.name, url: existing.url,
            token: existing.token, workspaceId: id
        )
        connection = updated
        try? await store.save(updated) // dedups by id — replaces in place
        await connect(using: updated)
    }

    private func connect(using connection: ServerConnection) async {
        if let existingClient = client {
            await existingClient.disconnect()
        }
        client = nil
        connectionRevision += 1
        connectionState = .connecting
        lastError = nil
        lastErrorCode = nil
        workspaceId = connection.workspaceId
        let transport = RPCTransport()
        // F1: pin before connecting, so a changed certificate is refused at the
        // handshake rather than after the token has already crossed the wire.
        if let fingerprint = connection.pinnedFingerprint {
            await transport.setPinnedFingerprint(CertificateFingerprint(value: fingerprint))
        }
        let client = RPCClient(transport: transport)
        do {
            try await client.connect(
                serverURL: connection.url,
                token: connection.token,
                workspaceId: connection.workspaceId
            )
            self.client = client
            connectionRevision += 1
            connectionState = .connected
            workspaces = (try? await client.listWorkspaces()) ?? []
        } catch {
            self.client = nil
            // F14-UI: never the raw type dump — the owner screenshotted one.
            let presented = presentedError(error)
            lastError = presented.message
            lastErrorCode = presented.code
            connectionState = .failed(ConnectionError(kind: .network, message: presented.message))
            if presented.isCredentialRejection {
                try? await store.delete(id: connection.id)
                self.connection = nil
                savedCredentialRejected = true
            }
        }
    }
}
