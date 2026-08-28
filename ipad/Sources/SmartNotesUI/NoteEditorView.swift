#if canImport(UIKit)
import PencilKit
import SmartNotesDocuments
import SmartNotesKit
import SwiftUI

/// A note: typed text on one tab, handwriting on the other.
///
/// Both halves save the same way — into the operation log, on disk, before the
/// view redraws — so switching tabs, leaving the screen or losing power keeps
/// the work. Typing is debounced only to keep one operation per pause rather
/// than one per keystroke; the debounce never outlives the screen, because
/// `onDisappear` flushes it.
struct NoteEditorView: View {
    @ObservedObject var session: NotebookSession
    let noteId: String

    @State private var title = ""
    @State private var body_ = ""
    @State private var drawing = PKDrawing()
    @State private var mode = Mode.text
    @State private var loaded = false
    @State private var saveTask: Task<Void, Never>?

    enum Mode: String, CaseIterable, Identifiable {
        case text = "Text"
        case ink = "Handwriting"
        var id: String { rawValue }
    }

    private var note: Note? { session.notes.first { $0.id == noteId } }

    var body: some View {
        Group {
            if note == nil {
                MessageView(
                    symbol: "trash",
                    title: "This note was deleted",
                    detail: "Another device deleted this note. Go back to see what is left in the notebook."
                )
            } else {
                VStack(spacing: 0) {
                    Picker("Mode", selection: $mode) {
                        ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    .padding(.top, 8)

                    switch mode {
                    case .text:
                        TextEditor(text: $body_)
                            .font(.body)
                            .padding(.horizontal, 12)
                            .onChange(of: body_) { scheduleSave() }
                            .overlay(alignment: .topLeading) {
                                if body_.isEmpty {
                                    Text("Start writing…")
                                        .foregroundStyle(.tertiary)
                                        .padding(.horizontal, 17)
                                        .padding(.vertical, 8)
                                        .allowsHitTesting(false)
                                }
                            }
                    case .ink:
                        InkCanvasView(drawing: $drawing)
                            .onChange(of: drawing) { saveInk() }
                            .background(Color(uiColor: .systemBackground))
                    }
                }
            }
        }
        .navigationTitle(title.isEmpty ? "Untitled note" : title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                TextField("Title", text: $title)
                    .textFieldStyle(.plain)
                    .multilineTextAlignment(.center)
                    .frame(minWidth: 200)
                    .onSubmit { flush() }
            }
        }
        .task { load() }
        .onDisappear { flush() }
    }

    private func load() {
        guard !loaded, let note else { return }
        title = note.title
        body_ = note.body
        drawing = (try? PencilKitInk.load(from: session.engine, targetKind: .note, targetId: noteId)) ?? PKDrawing()
        loaded = true
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            flush()
        }
    }

    /// Writes whatever differs from the folded state. Comparing first is what
    /// keeps reopening a note from authoring a no-op operation.
    private func flush() {
        saveTask?.cancel()
        saveTask = nil
        guard let note else { return }
        session.updateNote(
            noteId,
            title: note.title == title ? nil : title,
            body: note.body == body_ ? nil : body_
        )
    }

    /// PencilKit hands over a whole drawing rather than a delta; the engine
    /// diffs it, so an unchanged canvas writes nothing.
    private func saveInk() {
        session.edit { engine in
            try PencilKitInk.save(drawing, to: engine, targetKind: .note, targetId: noteId)
        }
    }
}
#endif
