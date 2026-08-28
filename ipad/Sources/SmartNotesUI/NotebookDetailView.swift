#if canImport(UIKit)
import SmartNotesKit
import SwiftUI
import UniformTypeIdentifiers

/// Opening a notebook can fail — an unreadable replica on disk is the realistic
/// case — so the open is a state with a retry rather than a force-unwrap.
struct NotebookScreen: View {
    @ObservedObject var library: Library
    let notebook: Notebook

    @State private var session: NotebookSession?
    @State private var openError: String?

    var body: some View {
        Group {
            if let session {
                NotebookDetailView(session: session)
            } else if let openError {
                MessageView(
                    symbol: "exclamationmark.triangle",
                    title: "This notebook could not be opened",
                    detail: openError,
                    action: ("Try again", open)
                )
            } else {
                MessageView(
                    symbol: "book",
                    title: "Opening \(notebook.title)",
                    detail: "Reading this notebook from the iPad.",
                    inProgress: true
                )
            }
        }
        .task { if session == nil { open() } }
    }

    private func open() {
        openError = nil
        do {
            let opened = try library.open(notebook)
            session = opened
            // The first sync is fire-and-forget: the notebook is already
            // readable from the local replica, so nothing waits on it.
            Task { await opened.sync() }
        } catch {
            openError = "\(error)"
        }
    }
}

/// One notebook: its notes, its PDFs, and the single line that explains where
/// its edits currently stand.
struct NotebookDetailView: View {
    @ObservedObject var session: NotebookSession
    @State private var showConflicts = false
    @State private var newNoteTitle = ""
    @State private var creatingNote = false
    @State private var renaming = false
    @State private var newNotebookTitle = ""
    @State private var importingPdf = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let banner = session.banner {
                    BannerView(banner: banner, onReview: banner.isConflict ? { showConflicts = true } : nil)
                }
                if let writeError = session.writeError {
                    BannerView(banner: .failed(writeError))
                }
                content
            }
            .navigationTitle(session.notebook.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("New note", systemImage: "square.and.pencil") { creatingNote = true }
                        Button("Add a PDF", systemImage: "doc.badge.plus") { importingPdf = true }
                        Button("Rename notebook", systemImage: "pencil") {
                            newNotebookTitle = session.notebook.title
                            renaming = true
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Add to this notebook")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await session.sync() } } label: {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    }
                    .disabled(session.isLoading)
                    .accessibilityLabel("Sync now")
                }
                if !session.conflicts.isEmpty {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { showConflicts = true } label: {
                            Label("\(session.conflicts.count)", systemImage: "arrow.triangle.branch")
                        }
                        .accessibilityLabel("Review conflicts")
                    }
                }
            }
            .sheet(isPresented: $showConflicts) { ConflictsView(session: session) }
            .alert("New note", isPresented: $creatingNote) {
                TextField("Title", text: $newNoteTitle)
                Button("Create") {
                    let title = newNoteTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                    newNoteTitle = ""
                    _ = session.createNote(title: title.isEmpty ? "Untitled note" : title)
                }
                Button("Cancel", role: .cancel) { newNoteTitle = "" }
            } message: {
                Text("Notes are saved on this iPad immediately, with or without a connection.")
            }
            .alert("Rename notebook", isPresented: $renaming) {
                TextField("Title", text: $newNotebookTitle)
                Button("Rename") {
                    let title = newNotebookTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !title.isEmpty else { return }
                    session.renameNotebook(title)
                }
                Button("Cancel", role: .cancel) {}
            }
            .fileImporter(isPresented: $importingPdf, allowedContentTypes: [.pdf]) { result in
                importPdf(result)
            }
            .refreshable { await session.sync() }
        }
    }

    /// A PDF picked from Files. The bytes are read inside the security-scoped
    /// access the picker grants, before any await, because that access does not
    /// outlive this call.
    private func importPdf(_ result: Result<URL, Error>) {
        switch result {
        case let .failure(error):
            session.report("That PDF could not be read: \(error.localizedDescription)")
        case let .success(url):
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let bytes = try? Data(contentsOf: url) else {
                session.report("That PDF could not be read from Files.")
                return
            }
            Task { _ = await session.importPdf(filename: url.lastPathComponent, bytes: bytes) }
        }
    }

    @ViewBuilder
    private var content: some View {
        if session.isEmpty {
            MessageView(
                symbol: "doc.text",
                title: "This notebook is empty",
                detail: "Create a note to start writing or drawing, or add a PDF to read and annotate.",
                action: ("New note", { creatingNote = true })
            )
        } else {
            List {
                if !session.notes.isEmpty {
                    Section("Notes") {
                        ForEach(session.notes) { note in
                            NavigationLink {
                                NoteEditorView(session: session, noteId: note.id)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(note.title.isEmpty ? "Untitled note" : note.title)
                                    if !note.body.isEmpty {
                                        Text(note.body)
                                            .font(.footnote)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                }
                            }
                        }
                        .onDelete { offsets in
                            for index in offsets { session.deleteNote(session.notes[index].id) }
                        }
                    }
                }
                if !session.pdfs.isEmpty {
                    Section("PDFs") {
                        ForEach(session.pdfs) { pdf in
                            NavigationLink {
                                PDFReaderView(session: session, document: pdf)
                            } label: {
                                Label {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(pdf.filename)
                                        Text("\(pdf.pageCount) \(pdf.pageCount == 1 ? "page" : "pages")")
                                            .font(.footnote)
                                            .foregroundStyle(.secondary)
                                    }
                                } icon: {
                                    Image(systemName: session.isPdfAvailableOffline(pdf) ? "doc.richtext.fill" : "doc.richtext")
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

extension StatusBanner {
    var isConflict: Bool {
        if case .conflicts = self { return true }
        return false
    }
}
#endif
