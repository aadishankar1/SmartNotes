#if canImport(UIKit)
import SmartNotesDocuments
import SmartNotesKit
import SwiftUI

/// Signed out or signed in. There is no third state: a saved session is
/// restored from disk before the first frame, so the app never flashes the
/// token screen at a user who is already signed in.
struct RootView: View {
    @ObservedObject var library: Library

    var body: some View {
        if library.session == nil {
            SignInView(library: library)
        } else {
            LibraryView(library: library)
        }
    }
}

/// The MVP authenticates with a server-issued API token rather than a signup
/// flow, so this screen takes an address and a token and nothing else.
struct SignInView: View {
    @ObservedObject var library: Library
    @State private var baseURL = "http://localhost:8787"
    @State private var token = ""
    @State private var busy = false

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "book.closed").font(.system(size: 48)).foregroundStyle(.tint)
            Text("SmartNotes").font(.largeTitle.weight(.semibold))
            Text("Sign in with the API token your SmartNotes server issued.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            VStack(alignment: .leading, spacing: 12) {
                LabeledContent("Server") {
                    TextField("https://…", text: $baseURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }
                LabeledContent("API token") {
                    SecureField("Paste your token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .textFieldStyle(.roundedBorder)
            .frame(maxWidth: 480)

            if let notice = library.notice {
                Label(notice, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 480)
            }

            Button {
                busy = true
                Task {
                    _ = await library.signIn(baseURL: baseURL, token: token)
                    busy = false
                }
            } label: {
                if busy { ProgressView() } else { Text("Sign in").frame(maxWidth: 200) }
            }
            .buttonStyle(.borderedProminent)
            .disabled(busy || token.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The iPad layout: notebooks on the left, the selected notebook on the right.
struct LibraryView: View {
    @ObservedObject var library: Library
    @State private var selection: Notebook.ID?
    @State private var creating = false
    @State private var newTitle = ""

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationTitle("Notebooks")
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button { creating = true } label: { Image(systemName: "plus") }
                            .accessibilityLabel("New notebook")
                    }
                    ToolbarItem(placement: .topBarLeading) {
                        Menu {
                            Button("Refresh") { Task { await library.refresh() } }
                            if let session = library.session {
                                Section(session.user.displayName) {
                                    Button("Sign out", role: .destructive) { try? library.signOut() }
                                }
                            }
                        } label: {
                            Image(systemName: "person.crop.circle")
                        }
                        .accessibilityLabel("Account")
                    }
                }
                .refreshable { await library.refresh() }
                .alert("New notebook", isPresented: $creating) {
                    TextField("Title", text: $newTitle)
                    Button("Create") {
                        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                        newTitle = ""
                        guard !title.isEmpty else { return }
                        Task {
                            if let notebook = await library.createNotebook(title: title) {
                                selection = notebook.id
                            }
                        }
                    }
                    Button("Cancel", role: .cancel) { newTitle = "" }
                } message: {
                    Text("Notebooks are created on the server, so this needs a connection.")
                }
        } detail: {
            if let id = selection, let notebook = library.notebooks.first(where: { $0.id == id }) {
                NotebookScreen(library: library, notebook: notebook)
                    .id(notebook.id)
            } else {
                MessageView(
                    symbol: "sidebar.left",
                    title: "Choose a notebook",
                    detail: "Pick a notebook on the left to read, write and annotate it."
                )
            }
        }
    }

    @ViewBuilder
    private var sidebar: some View {
        switch library.phase {
        case .signedOut, .loading:
            MessageView(
                symbol: "arrow.triangle.2.circlepath",
                title: "Loading notebooks",
                detail: "Fetching your notebooks from the server.",
                inProgress: true
            )
        case let .failed(message):
            MessageView(
                symbol: "exclamationmark.triangle",
                title: "Could not load your notebooks",
                detail: message,
                action: ("Try again", { Task { await library.refresh() } })
            )
        case .empty:
            VStack(spacing: 0) {
                if library.offline, let notice = library.notice {
                    BannerView(banner: .failed(notice))
                }
                MessageView(
                    symbol: "book",
                    title: "No notebooks yet",
                    detail: "Create your first notebook to start writing, drawing and annotating PDFs.",
                    action: ("New notebook", { creating = true })
                )
            }
        case .ready:
            VStack(spacing: 0) {
                if library.offline {
                    BannerView(banner: .offline(pending: 0))
                } else if let notice = library.notice {
                    BannerView(banner: .failed(notice))
                }
                List(library.notebooks, selection: $selection) { notebook in
                    Label {
                        Text(notebook.title)
                    } icon: {
                        Image(systemName: "book.closed.fill")
                            .foregroundStyle(notebook.color.flatMap(Color.init(hex:)) ?? .accentColor)
                    }
                    .tag(notebook.id)
                }
                .listStyle(.sidebar)
            }
        }
    }
}

extension Color {
    /// The contract stores colours as `#rrggbb`; an unparseable value falls
    /// back rather than crashing a list row.
    init?(hex: String) {
        guard let platform = HexColor.color(hex) else { return nil }
        self.init(uiColor: platform)
    }
}
#endif
