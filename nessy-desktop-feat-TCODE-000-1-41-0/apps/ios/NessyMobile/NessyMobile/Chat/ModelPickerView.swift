// apps/ios/NessyMobile/NessyMobile/Chat/ModelPickerView.swift
import SwiftUI
import NessyAgentKit

/// Two controls, not one tree.
///
/// The integration row moves the session (`sessions:command` `switchRuntime`);
/// the model list below it only ever shows the ACTIVE integration's models and
/// applies them with `session:setModel`. Listing every connection's models in
/// one flat tree — which this view used to do — cannot work since T3: the
/// model-catalog guard rejects a model that does not belong to the session's
/// connection, so a tap on another integration's model was a silent no-op.
/// Splitting the controls also means the confirmation fires once per real
/// decision instead of once per tap near one. Cost: reaching another
/// integration's model is two taps instead of one.
struct ModelPickerView: View {
    @Bindable var viewModel: ChatViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var isLoading = true
    @State private var pendingSwitch: PendingSwitch?

    /// A target the user picked that needs answering for first.
    private struct PendingSwitch: Identifiable {
        let connection: LlmConnection
        let title: String
        let body: String
        var id: String { connection.slug }
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                } else if viewModel.availableConnections.isEmpty {
                    ContentUnavailableView("No models available", systemImage: "cpu")
                } else {
                    List {
                        integrationSection
                        modelSection
                    }
                }
            }
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .alert(item: $pendingSwitch) { pending in
                Alert(
                    title: Text(pending.title),
                    message: Text(pending.body),
                    primaryButton: .default(Text("Switch")) { runSwitch(to: pending.connection) },
                    secondaryButton: .cancel()
                )
            }
            .task {
                await viewModel.loadConnections()
                isLoading = false
            }
        }
    }

    @ViewBuilder
    private var integrationSection: some View {
        Section("Integration") {
            if viewModel.connectionSwitchable {
                NavigationLink {
                    integrationList
                } label: {
                    integrationLabel
                }
            } else {
                // `nestor-cloud-agent` is out of scope in both directions: a
                // session already on it keeps today's behaviour.
                integrationLabel
            }
        }
    }

    private var integrationLabel: some View {
        HStack {
            Text(viewModel.activeConnection?.name ?? "Not set").foregroundStyle(.primary)
            Spacer()
            if let runtime = viewModel.activeConnection?.agentRuntime {
                Text(runtime.label).foregroundStyle(.secondary)
            }
        }
    }

    private var integrationList: some View {
        List {
            ForEach(viewModel.switchTargets) { connection in
                Button {
                    pick(connection)
                } label: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(connection.name).foregroundStyle(.primary)
                            Text(connection.agentRuntime.label).font(.footnote).foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                }
            }
        }
        .navigationTitle("Integration")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private var modelSection: some View {
        Section("Model") {
            Button {
                apply(model: nil)
            } label: {
                row(title: "Workspace default", selected: viewModel.currentModel == nil)
            }
            ForEach(viewModel.activeConnection?.selectableModels ?? []) { model in
                Button {
                    apply(model: model.modelId)
                } label: {
                    row(title: model.displayName, selected: viewModel.currentModel == model.modelId)
                }
            }
        }
    }

    private func row(title: String, selected: Bool) -> some View {
        HStack {
            Text(title).foregroundStyle(.primary)
            Spacer()
            if selected {
                Image(systemName: "checkmark").foregroundStyle(.tint)
            }
        }
    }

    /// A pick either asks first or runs straight away — the tiering lives in
    /// `RuntimeSwitch.confirmation`, so this view never decides it.
    private func pick(_ connection: LlmConnection) {
        guard let confirmation = viewModel.switchConfirmation(for: connection) else {
            return runSwitch(to: connection)
        }
        pendingSwitch = PendingSwitch(connection: connection, title: confirmation.title, body: confirmation.body)
    }

    private func runSwitch(to connection: LlmConnection) {
        Task { await viewModel.switchRuntime(to: connection.slug) }
        dismiss()
    }

    /// The model list is scoped to the active integration, so a pick never
    /// carries a connection: `setModel` cannot move the session.
    private func apply(model: String?) {
        Task { await viewModel.setModel(model) }
        dismiss()
    }
}
