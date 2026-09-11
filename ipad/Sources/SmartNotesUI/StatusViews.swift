#if canImport(UIKit)
import SmartNotesKit
import SwiftUI

/// The one view every empty, loading and error state in the app is built from,
/// so those states look deliberate rather than like three different oversights.
struct MessageView: View {
    var symbol: String
    var title: String
    var detail: String
    var inProgress: Bool = false
    var action: (String, () -> Void)?

    var body: some View {
        VStack(spacing: 16) {
            if inProgress {
                ProgressView().controlSize(.large)
            } else {
                Image(systemName: symbol)
                    .font(.system(size: 44))
                    .foregroundStyle(.secondary)
            }
            Text(title).font(.title3.weight(.semibold))
            Text(detail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            if let action {
                Button(action.0, action: action.1).buttonStyle(.borderedProminent)
            }
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The sync status line. Offline is deliberately not styled as an error: the
/// edits are safe, and colouring it red would say otherwise.
struct BannerView: View {
    var banner: StatusBanner
    var onReview: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
            Text(banner.message).font(.footnote)
            Spacer(minLength: 8)
            if let onReview, banner.isActionable {
                Button("Review", action: onReview).font(.footnote.weight(.semibold))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.15))
        .foregroundStyle(tint)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(banner.message)
    }

    private var symbol: String {
        switch banner {
        case .syncing: return "arrow.triangle.2.circlepath"
        case .synced: return "checkmark.circle"
        case .offline: return "wifi.slash"
        case .failed: return "exclamationmark.triangle"
        case .conflicts: return "arrow.triangle.branch"
        case .rejected: return "xmark.octagon"
        }
    }

    private var tint: Color {
        switch banner {
        case .syncing, .synced: return .secondary
        case .offline: return .orange
        case .failed, .rejected: return .red
        case .conflicts: return .purple
        }
    }
}

/// Conflicts, with both sides shown. Nothing is discarded on the user's behalf:
/// the losing value is offered back as a fresh edit they can take or leave.
struct ConflictsView: View {
    @ObservedObject var session: NotebookSession
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if session.conflicts.isEmpty {
                    MessageView(
                        symbol: "checkmark.circle",
                        title: "No conflicts",
                        detail: "Every edit from your other devices merged cleanly."
                    )
                } else {
                    List(session.conflicts) { conflict in
                        VStack(alignment: .leading, spacing: 6) {
                            Text("\(conflict.entityKind.rawValue.capitalized) · \(conflict.field)")
                                .font(.headline)
                            Text("Kept: \(Self.preview(conflict.winner.value))")
                            ForEach(Array(conflict.losers.enumerated()), id: \.offset) { _, loser in
                                HStack {
                                    Text("Replaced: \(Self.preview(loser.value))")
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                }
                            }
                            Button("Restore the replaced version") { session.restore(conflict) }
                                .font(.footnote.weight(.semibold))
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .navigationTitle("Conflicts")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    static func preview(_ value: JSONValue) -> String {
        if case let .string(text) = value { return text.isEmpty ? "(empty)" : text }
        return (try? value.canonicalString()) ?? "—"
    }
}
#endif
