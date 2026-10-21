// apps/ios/NessyMobile/NessyMobile/Onboarding/ServerConnectionViewModel.swift
import Foundation
import Observation
import NessyAgentKit

enum ServerConnectionSetupError: LocalizedError {
    case invalidServerURL
    case connectionNotTested

    var errorDescription: String? {
        switch self {
        case .invalidServerURL:
            "Enter a valid ws:// or wss:// server address."
        case .connectionNotTested:
            "Test the connection before choosing a workspace."
        }
    }
}

@Observable
@MainActor
final class ServerConnectionViewModel {
    var serverURLText: String = ""
    var token: String = ""
    var connectionState: ConnectionState = .idle
    var workspaces: [Workspace] = []
    var errorMessage: String?

    private let store: ServerConnectionStore
    private var pendingClient: RPCClient?
    private var testedServerURL: URL?
    private var testedToken: String?

    var isConnecting: Bool {
        if case .connecting = connectionState { return true }
        return false
    }

    var canConnect: Bool {
        validatedServerURL != nil
            && !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isConnecting
            && !hasVerifiedConnection
    }

    var hasVerifiedConnection: Bool {
        pendingClient != nil
            && testedServerURL == validatedServerURL
            && testedToken == token
    }

    var validatedServerURL: URL? {
        let trimmed = serverURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let candidate = trimmed.contains("://") ? trimmed : "wss://\(trimmed)"
        guard let components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              components.host?.isEmpty == false else {
            return nil
        }
        return components.url
    }

    init(store: ServerConnectionStore) {
        self.store = store
    }

    func testConnectionAndFetchWorkspaces() async {
        guard let url = validatedServerURL else {
            errorMessage = ServerConnectionSetupError.invalidServerURL.localizedDescription
            return
        }
        // NESSY DEVIATION (M5): a token is compared byte-for-byte on the server,
        // and a token copied out of a terminal almost always carries a trailing
        // newline or space. Untrimmed, that is reported as "Invalid token" —
        // indistinguishable from actually having the wrong secret.
        let tokenToTest = token.trimmingCharacters(in: .whitespacesAndNewlines)
        token = tokenToTest
        await pendingClient?.disconnect()
        pendingClient = nil
        testedServerURL = nil
        testedToken = nil
        workspaces = []
        pendingFingerprint = nil
        fingerprintConfirmed = false
        canRetryWithoutTLS = false
        errorMessage = nil
        connectionState = .connecting
        let transport = RPCTransport()
        let client = RPCClient(transport: transport)
        do {
            try await client.connect(serverURL: url, token: tokenToTest, workspaceId: nil)
            // F1: a self-signed certificate was accepted for the length of this
            // probe so its fingerprint could be READ. Nothing is saved until the
            // user confirms it matches what the server printed.
            if url.scheme == "wss", let presented = await transport.presentedFingerprint() {
                pendingFingerprint = presented
            } else {
                pendingFingerprint = nil
            }
            workspaces = try await client.listWorkspaces()
            pendingClient = client
            testedServerURL = url
            testedToken = tokenToTest
            connectionState = .connected
        } catch {
            let presented = presentedError(error)
            connectionState = .failed(ConnectionError(kind: .unknown, message: presented.message))
            errorMessage = presented.message
            // F2: only offer the downgrade when we actually dialled wss — the
            // offer must never appear on a failure it cannot fix.
            canRetryWithoutTLS = presented.isPlainServerBehindTLSDial && url.scheme == "wss"
        }
    }

    /// F5: applies a scanned QR (or an opened `nessy://pair?…` link) and
    /// connects. The QR is a trusted side channel — it is displayed on the
    /// machine running the server — so a fingerprint carried in it is already
    /// confirmed by the act of scanning that screen, and the manual comparison
    /// is skipped rather than asked twice.
    func apply(_ payload: PairingPayload) async {
        serverURLText = payload.url.absoluteString
        token = payload.token
        await testConnectionAndFetchWorkspaces()
        if let scanned = payload.fingerprint {
            pendingFingerprint = scanned
            fingerprintConfirmed = true
        }
    }

    /// F2: set when the dial failed because the server speaks plain `ws`. The
    /// UI offers a one-tap retry; the nudge stays toward TLS.
    var canRetryWithoutTLS = false

    /// Rewrites the address to `ws://` and retries. Deliberately explicit —
    /// this is a downgrade, so it is a thing the user does, never automatic.
    func retryWithoutTLS() async {
        guard let url = validatedServerURL, url.scheme == "wss" else { return }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.scheme = "ws"
        guard let downgraded = components?.url else { return }
        serverURLText = downgraded.absoluteString
        canRetryWithoutTLS = false
        await testConnectionAndFetchWorkspaces()
    }

    /// F1: the fingerprint the server presented, awaiting the user's comparison.
    /// `nil` for `ws://` or a certificate the system already trusts.
    var pendingFingerprint: CertificateFingerprint?
    /// Set when the user says the fingerprint matches what the server printed.
    var fingerprintConfirmed = false

    /// The workspace step stays closed until the certificate question is
    /// answered — pairing past an unverified certificate is the one order that
    /// would make the whole exercise decorative.
    var isReadyToChooseWorkspace: Bool {
        hasVerifiedConnection && !workspaces.isEmpty && (pendingFingerprint == nil || fingerprintConfirmed)
    }

    func saveAndConnect(workspaceId: String) async throws {
        guard let url = validatedServerURL else {
            throw ServerConnectionSetupError.invalidServerURL
        }
        guard hasVerifiedConnection else {
            throw ServerConnectionSetupError.connectionNotTested
        }
        let connection = ServerConnection(
            name: url.host ?? "Server",
            url: url,
            token: token,
            workspaceId: workspaceId,
            // Only a CONFIRMED fingerprint is pinned. An unconfirmed one would
            // pin whatever answered on that address, which is the failure this
            // whole flow exists to prevent.
            pinnedFingerprint: fingerprintConfirmed ? pendingFingerprint?.value : nil
        )
        try await store.save(connection)
        await pendingClient?.disconnect()
    }
}
