import SwiftUI
import SwiftData
import NessyAgentKit

struct RootView: View {
    @State private var hasSavedConnection = false
    /// F5: a pairing link can arrive at ANY time, including while a paired
    /// session list is on screen. Handling it on the onboarding view only
    /// meant the link silently did nothing once the app was paired — measured.
    @State private var pendingPairing: PairingPayload?
    /// Whether a saved connection exists at all — the difference between
    /// "changing servers" (cancellable) and first-run pairing (not).
    @State private var hasEverPaired = false
    @State private var connectionViewModel = ServerConnectionViewModel(
        store: ServerConnectionStore(keychain: KeychainStore())
    )
    @State private var appClientProvider = AppClientProvider(
        store: ServerConnectionStore(keychain: KeychainStore())
    )
    private let cache = SessionCacheRepository(
        modelContainer: try! ModelContainer(for: Schema([CachedSession.self, CachedMessage.self]))
    )

    var body: some View {
        Group {
            if hasSavedConnection {
                SessionListView(
                    viewModel: SessionListViewModel(client: appClientProvider.client, cache: cache, workspaceId: appClientProvider.workspaceId),
                    onReconnect: { await appClientProvider.connectToSavedServer() },
                    onChangeServer: { hasSavedConnection = false },
                    workspaces: appClientProvider.workspaces,
                    currentWorkspaceId: appClientProvider.workspaceId,
                    onSwitchWorkspace: { await appClientProvider.switchWorkspace(to: $0) },
                    connectionError: appClientProvider.lastError,
                    connectionErrorCode: appClientProvider.lastErrorCode,
                    client: appClientProvider.client,
                    serverDisplayName: appClientProvider.serverDisplayName
                )
                // Rebuild view models whenever the provider replaces its RPC
                // client so no session remains bound to a disconnected transport.
                .id("\(appClientProvider.workspaceId ?? "none")-\(appClientProvider.connectionRevision)")
            } else {
                NavigationStack {
                    ServerConnectionSetupView(
                        viewModel: connectionViewModel,
                        incomingPairing: pendingPairing,
                        // Only offer a way back when there is something to go
                        // back to — during first-run pairing there is not.
                        onCancel: hasEverPaired ? { hasSavedConnection = true } : nil
                    ) {
                        Task {
                            await appClientProvider.connectToSavedServer()
                            hasSavedConnection = true
                        }
                    }
                }
            }
        }
        .onOpenURL { url in
            guard let payload = PairingPayload(scanned: url.absoluteString) else { return }
            pendingPairing = payload
            // Re-pairing is a deliberate act: show the pairing screen with the
            // scanned values applied rather than silently swapping servers
            // under a running session.
            hasSavedConnection = false
        }
        .preferredColorScheme(NessyThemeStore.shared.colorScheme)
        .task {
            let hasSaved = !((try? await ServerConnectionStore(keychain: KeychainStore()).list()) ?? []).isEmpty
            if hasSaved {
                await appClientProvider.connectToSavedServer()
            }
            // A saved credential the server refuses is worse than none: the app
            // would otherwise sit "offline" on a token that can never work.
            hasEverPaired = hasSaved && !appClientProvider.savedCredentialRejected
            hasSavedConnection = hasEverPaired
        }
    }
}

#Preview {
    RootView()
}
