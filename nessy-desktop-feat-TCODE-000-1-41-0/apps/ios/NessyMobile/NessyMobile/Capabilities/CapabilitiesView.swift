import SwiftUI
import NessyAgentKit

/// NESSY DEVIATION (F3): Skills and Sources, built on the Safe-capability
/// projection.
///
/// The raw list/detail routes were removed deliberately and re-adding them is a
/// stated failure, so this reads `capabilities:getCatalog` — the projection the
/// server already served before the app asked. It shows names, descriptions and
/// states; **no bodies, no absolute paths**. The safe model hides paths on
/// purpose and nothing here reconstructs one.
///
/// The whole surface is gated on `registeredChannels`: against a server that
/// does not serve the projection it does not appear at all, rather than
/// offering a screen that can only fail.
@MainActor
@Observable
final class CapabilitiesViewModel {
    private let client: RPCClient?
    private let sessionId: String
    private let workspaceId: String

    private(set) var skills: [SafeCapabilitySummary] = []
    private(set) var sources: [SafeCapabilitySummary] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?

    init(client: RPCClient?, sessionId: String, workspaceId: String) {
        self.client = client
        self.sessionId = sessionId
        self.workspaceId = workspaceId
    }

    func load() async {
        guard let client, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let catalog = try await client.getCapabilityCatalog(sessionId: sessionId, workspaceId: workspaceId)
            skills = catalog.skills
            sources = catalog.sources
            errorMessage = nil
        } catch {
            errorMessage = presentedError(error).message
        }
    }
}

struct CapabilitiesView: View {
    @Bindable var viewModel: CapabilitiesViewModel

    var body: some View {
        List {
            if let errorMessage = viewModel.errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            section("Skills", items: viewModel.skills, emptyNote: "No skills are available in this session.")
            section("Sources", items: viewModel.sources, emptyNote: "No sources are available in this session.")
        }
        .navigationTitle("Skills & Sources")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if viewModel.isLoading && viewModel.skills.isEmpty { ProgressView() } }
        .task { await viewModel.load() }
        .refreshable { await viewModel.load() }
    }

    @ViewBuilder
    private func section(_ title: LocalizedStringKey, items: [SafeCapabilitySummary], emptyNote: LocalizedStringKey) -> some View {
        Section(title) {
            if items.isEmpty {
                Text(emptyNote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            Text(item.title)
                                .font(.body.weight(.medium))
                            if let state = item.state, state != "active" {
                                Text(state)
                                    .font(.caption2)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color.primary.opacity(0.08), in: Capsule())
                            }
                        }
                        if let description = item.description, !description.isEmpty {
                            Text(description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }
}
