import SwiftUI
import NessyAgentKit

struct ServerConnectionSetupView: View {
    @Bindable var viewModel: ServerConnectionViewModel
    /// F5: a payload handed in by `RootView` when the app was opened with a
    /// pairing link. Applied once, on appear.
    var incomingPairing: PairingPayload?
    /// Set only when there is a connection to go BACK to. Reaching this screen
    /// from "Change Server" used to be a one-way door: the navigation bar is
    /// hidden for the hero layout, so a mis-tap stranded the user on pairing
    /// with no way to their sessions.
    var onCancel: (() -> Void)?
    var onConnected: () -> Void

    @FocusState private var focusedField: Field?
    @State private var isScannerPresented = false
    /// Scanning is the only route that requires no typing at all — no address,
    /// no 32-character token, and no fingerprint to compare by eye, since the
    /// QR carries it. Manual entry stays reachable because a QR is not always
    /// there to scan: `nessy-server` over SSH prints a link rather than a code,
    /// and a device can refuse camera access. Hidden, not removed.
    @State private var showsManualEntry = false

    private enum Field {
        case server
        case token
    }

    private var connectButtonTitle: String {
        if viewModel.isConnecting {
            return String(localized: "Connecting…")
        }
        if viewModel.hasVerifiedConnection {
            return String(localized: "Connected")
        }
        return String(localized: "Connect")
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                if let onCancel {
                    HStack {
                        Button(action: onCancel) {
                            Label("Sessions", systemImage: "chevron.left")
                                .font(.body.weight(.medium))
                        }
                        Spacer()
                    }
                }

                hero
                pairingActions

                if let errorMessage = viewModel.errorMessage {
                    errorCard(errorMessage)
                }

                if viewModel.canRetryWithoutTLS {
                    // F2: the downgrade is offered, never taken automatically —
                    // and the label says what it costs.
                    Button {
                        Task { await viewModel.retryWithoutTLS() }
                    } label: {
                        Label("Connect over ws:// anyway", systemImage: "lock.open")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }

                if let fingerprint = viewModel.pendingFingerprint, !viewModel.fingerprintConfirmed {
                    fingerprintCard(fingerprint)
                }

                if viewModel.isReadyToChooseWorkspace {
                    workspacePicker
                }

                Label("Your token is stored securely in this device's Keychain.", systemImage: "lock.shield")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: 520)
            .padding(.horizontal, 24)
            .padding(.top, 36)
            .padding(.bottom, 48)
            .frame(maxWidth: .infinity)
        }
        .task(id: incomingPairing) {
            guard let incomingPairing else { return }
            await viewModel.apply(incomingPairing)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showsManualEntry) { manualEntrySheet }
        .sheet(isPresented: $isScannerPresented) {
            NavigationStack {
                PairingScannerView(
                    onScanned: { payload in
                        isScannerPresented = false
                        Task { await viewModel.apply(payload) }
                    },
                    onFailed: { reason in
                        isScannerPresented = false
                        viewModel.errorMessage = reason
                        // A dead end is the one thing this screen must never
                        // be: if the camera cannot be used, show the fields.
                        showsManualEntry = true
                    }
                )
                .ignoresSafeArea()
                .navigationTitle("Scan pairing QR code")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { isScannerPresented = false }
                    }
                }
            }
        }
    }

    private var hero: some View {
        VStack(spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(NessyTheme.accentGradient)
                    .frame(width: 76, height: 76)
                    .shadow(color: NessyTheme.accent.opacity(0.25), radius: 18, y: 8)

                Image(systemName: "sparkles")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(.white)
            }

            VStack(spacing: 8) {
                Text("Nessy")
                    .font(.largeTitle.bold())

                Text("Connect to your server to monitor agents, continue conversations, and approve work from anywhere.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 430)
            }
        }
    }

    private var pairingActions: some View {
        VStack(spacing: 12) {
            Button {
                isScannerPresented = true
            } label: {
                Label("Scan pairing QR code", systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)

            Text("Open Settings → Server on your computer and scan the code shown there.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            // Secondary to the scan button, but unmistakably a CONTROL: as
            // plain grey text it read as a caption and nobody would tap it.
            Button {
                showsManualEntry = true
            } label: {
                Label("Other ways to connect", systemImage: "ellipsis.circle")
            }
            .buttonStyle(.bordered)
            .controlSize(.regular)
        }
        .frame(maxWidth: .infinity)
    }

    /// Everything that is not scanning, on its own screen: paste a link, or
    /// type the address and token. Kept out of the main flow because it is the
    /// exception — `nessy-server` over SSH prints a link rather than a code,
    /// and a device can refuse camera access — but never removed, because a
    /// pairing screen with no way forward is the one thing it must not be.
    private var manualEntrySheet: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    Button {
                        pastePairingLink()
                    } label: {
                        Label("Paste pairing link", systemImage: "doc.on.clipboard")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                    }
                    .buttonStyle(.borderedProminent)

                    Text("The server prints a pairing link when it starts. Pasting it fills everything in, including the certificate fingerprint.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)

                    Divider()

                    connectionCard

                    if let errorMessage = viewModel.errorMessage {
                        errorCard(errorMessage)
                    }

                    if viewModel.canRetryWithoutTLS {
                        Button {
                            Task { await viewModel.retryWithoutTLS() }
                        } label: {
                            Label("Connect over ws:// anyway", systemImage: "lock.open")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .frame(maxWidth: 520)
                .padding(24)
                .frame(maxWidth: .infinity)
            }
            .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
            .navigationTitle("Connect manually")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showsManualEntry = false }
                }
            }
            // The sheet's job ends the moment the server answers; the
            // fingerprint check and workspace choice belong to the main screen.
            .onChange(of: viewModel.hasVerifiedConnection) { _, verified in
                if verified { showsManualEntry = false }
            }
        }
    }

    private func pastePairingLink() {
        guard let text = UIPasteboard.general.string,
              let payload = PairingPayload(scanned: text)
        else {
            viewModel.errorMessage = String(localized: "The clipboard does not contain a Nessy pairing link.")
            return
        }
        Task { await viewModel.apply(payload) }
    }

    private var connectionCard: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 8) {
                Label("Server address", systemImage: "network")
                    .font(.subheadline.weight(.semibold))
                TextField("agents.example.com:9100", text: $viewModel.serverURLText)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .server)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .token }
                    .padding(12)
                    .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
                // A bare host:port is normalised to wss://. A local server
                // without TLS needs the scheme typed, and the failure it
                // produces otherwise is an opaque TLS error.
                Text("A plain address is treated as wss://. For a server on your network without TLS, type it in full: ws://192.168.1.10:9100")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 8) {
                Label("Access token", systemImage: "key")
                    .font(.subheadline.weight(.semibold))
                SecureField("Paste your server token", text: $viewModel.token)
                    .textContentType(.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focusedField, equals: .token)
                    .submitLabel(.go)
                    .onSubmit(connectIfReady)
                    .padding(12)
                    .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
            }

            Button {
                focusedField = nil
                Task { await viewModel.testConnectionAndFetchWorkspaces() }
            } label: {
                HStack(spacing: 8) {
                    if viewModel.isConnecting {
                        ProgressView()
                            .tint(.white)
                    } else if viewModel.hasVerifiedConnection {
                        Image(systemName: "checkmark")
                    } else {
                        Image(systemName: "arrow.right")
                    }
                    Text(connectButtonTitle)
                        .fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 28)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!viewModel.canConnect)
        }
        .padding(20)
        .background(NessyTheme.cardBackground, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(NessyTheme.hairline)
        }
    }

    private func errorCard(_ message: String) -> some View {
        Label {
            Text(message)
                .frame(maxWidth: .infinity, alignment: .leading)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .font(.callout)
        .foregroundStyle(.red)
        .padding(14)
        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .combine)
    }

    private var workspacePicker: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Label("Choose a workspace", systemImage: "square.stack.3d.up")
                    .font(.headline)
                Text("Your sessions and server settings are scoped to this workspace.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            VStack(spacing: 0) {
                ForEach(Array(viewModel.workspaces.enumerated()), id: \.element.id) { index, workspace in
                    Button {
                        select(workspace)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "folder")
                                .foregroundStyle(NessyTheme.accent)
                                .frame(width: 24)
                            Text(workspace.name)
                                .foregroundStyle(.primary)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if index < viewModel.workspaces.count - 1 {
                        Divider()
                            .padding(.leading, 52)
                    }
                }
            }
            .background(NessyTheme.cardBackground, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(NessyTheme.hairline)
            }
        }
    }

    private func connectIfReady() {
        guard viewModel.canConnect else { return }
        focusedField = nil
        Task { await viewModel.testConnectionAndFetchWorkspaces() }
    }

    /// F1: the human is the trust anchor for a self-signed certificate, so the
    /// comparison has to be presented as a comparison — the fingerprint the
    /// server printed, beside the one this device actually received.
    private func fingerprintCard(_ fingerprint: CertificateFingerprint) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Check the server's fingerprint", systemImage: "lock.shield")
                .font(.subheadline.weight(.semibold))
            Text("This server uses a self-signed certificate. It printed a fingerprint when it started — confirm it is the same one below before pairing.")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(fingerprint.value)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
            Button {
                viewModel.fingerprintConfirmed = true
            } label: {
                Text("It matches — continue")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(16)
        .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 16))
    }

    private func select(_ workspace: Workspace) {
        Task {
            do {
                try await viewModel.saveAndConnect(workspaceId: workspace.id)
                onConnected()
            } catch {
                viewModel.errorMessage = "Could not save this connection: \(error.localizedDescription)"
            }
        }
    }
}
