#if canImport(UIKit)
import PDFKit
import PencilKit
import SmartNotesDocuments
import SmartNotesKit
import SwiftUI

/// Reads a PDF and annotates it.
///
/// The file on disk stays exactly the bytes the server hashed. Highlights,
/// notes and ink are operations in the notebook's log, drawn onto the page by
/// `PDFAnnotationBridge` every time the document is opened — which is why an
/// annotation survives reopening, and survives arriving from another device.
struct PDFReaderView: View {
    @ObservedObject var session: NotebookSession
    let document: PdfDocument

    @StateObject private var handle = PDFViewHandle()
    @State private var phase = Phase.loading
    @State private var drawing = PKDrawing()
    @State private var isDrawing = false
    @State private var noteText = ""
    @State private var askingForNote = false

    enum Phase {
        case loading
        case ready(PDFDocument)
        case failed(String)
    }

    var body: some View {
        Group {
            switch phase {
            case .loading:
                MessageView(
                    symbol: "doc.richtext",
                    title: "Opening \(document.filename)",
                    detail: session.isPdfAvailableOffline(document)
                        ? "Reading the copy stored on this iPad."
                        : "Downloading this PDF so it is available offline too.",
                    inProgress: true
                )
            case let .failed(message):
                MessageView(
                    symbol: "exclamationmark.triangle",
                    title: "This PDF could not be opened",
                    detail: message,
                    action: ("Try again", { Task { await load() } })
                )
            case let .ready(pdf):
                ZStack {
                    PDFDocumentView(
                        document: pdf,
                        annotations: annotations,
                        strokes: strokes,
                        handle: handle
                    )
                    if isDrawing {
                        InkCanvasView(drawing: $drawing)
                            .background(Color.clear)
                    }
                }
            }
        }
        .navigationTitle(document.filename)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .alert("Add a note", isPresented: $askingForNote) {
            TextField("Note", text: $noteText)
            Button("Add") { addNoteAnnotation() }
            Button("Cancel", role: .cancel) { noteText = "" }
        } message: {
            Text("The note is anchored to the text you selected.")
        }
        .task { await load() }
    }

    private var annotations: [Annotation] {
        (try? session.annotations(for: document)) ?? []
    }

    private var strokes: [InkStroke] {
        (try? session.strokes(for: document)) ?? []
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button { addHighlight() } label: { Image(systemName: "highlighter") }
                .accessibilityLabel("Highlight selection")
        }
        ToolbarItem(placement: .primaryAction) {
            Button { askingForNote = true } label: { Image(systemName: "note.text.badge.plus") }
                .accessibilityLabel("Add a note")
        }
        ToolbarItem(placement: .primaryAction) {
            Button {
                if isDrawing { commitInk() }
                isDrawing.toggle()
            } label: {
                Image(systemName: isDrawing ? "checkmark.circle.fill" : "pencil.tip.crop.circle")
            }
            .accessibilityLabel(isDrawing ? "Finish drawing" : "Draw on this page")
        }
    }

    // MARK: - Loading

    private func load() async {
        phase = .loading
        do {
            let bytes = try await session.pdfData(document)
            guard let pdf = PDFDocument(data: bytes) else {
                phase = .failed("The downloaded file is not a readable PDF.")
                return
            }
            phase = .ready(pdf)
        } catch let error as APIError where error.isOffline {
            phase = .failed("You're offline and this PDF has not been downloaded to this iPad yet.")
        } catch {
            phase = .failed((error as? APIError)?.userMessage ?? "\(error)")
        }
    }

    // MARK: - Annotating

    /// The selection's own rectangle, in PDF user space — the same coordinate
    /// system the shared record stores, so the highlight lands on the same
    /// words on every device.
    private func selectionRect() -> (page: Int, rect: Rect, text: String?)? {
        guard let view = handle.view,
              let pdf = view.document,
              let selection = view.currentSelection,
              let page = selection.pages.first
        else { return nil }
        var bounds = selection.bounds(for: page)
        for line in selection.selectionsByLine() {
            bounds = bounds.union(line.bounds(for: page))
        }
        let index = pdf.index(for: page)
        guard index != NSNotFound else { return nil }
        return (
            index,
            Rect(
                x: max(0, Double(bounds.origin.x)),
                y: max(0, Double(bounds.origin.y)),
                width: max(0, Double(bounds.size.width)),
                height: max(0, Double(bounds.size.height))
            ),
            selection.string
        )
    }

    private func addHighlight() {
        guard let selection = selectionRect() else {
            session.report("Select the text you want to mark up first.")
            return
        }
        session.edit { engine in
            _ = try engine.addHighlight(
                pdfId: document.id,
                page: selection.page,
                rect: selection.rect,
                color: HexColor.defaultHighlight,
                text: selection.text
            )
        }
        handle.view?.clearSelection()
    }

    private func addNoteAnnotation() {
        let text = noteText.trimmingCharacters(in: .whitespacesAndNewlines)
        noteText = ""
        guard !text.isEmpty else { return }
        guard let selection = selectionRect() else {
            session.report("Select the text you want to mark up first.")
            return
        }
        session.edit { engine in
            _ = try engine.addNoteAnnotation(
                pdfId: document.id,
                page: selection.page,
                rect: selection.rect,
                text: text
            )
        }
        handle.view?.clearSelection()
    }

    /// Turns what was drawn on the overlay into ink annotations.
    ///
    /// The canvas is in view coordinates and the record is in page
    /// coordinates, so every control point goes through PDFKit's own
    /// conversion. Without it a stroke would land in the right place only at
    /// the zoom level it was drawn at.
    private func commitInk() {
        guard !drawing.strokes.isEmpty,
              let view = handle.view,
              let pdf = view.document,
              let page = view.currentPage
        else {
            drawing = PKDrawing()
            return
        }
        let index = pdf.index(for: page)
        guard index != NSNotFound else { return }

        session.edit { engine in
            for stroke in drawing.strokes {
                let transform = stroke.transform
                let points = stroke.path.map { point -> Ink.Point in
                    // The overlay sits exactly over the PDF view, so a canvas
                    // point is already a view point; only the view-to-page
                    // conversion is needed.
                    let onPage = view.convert(point.location.applying(transform), to: page)
                    return Ink.Point(
                        x: Double(onPage.x),
                        y: Double(onPage.y),
                        pressure: min(1, max(0, Double(point.force))),
                        t: point.timeOffset * 1000
                    )
                }
                guard !points.isEmpty else { continue }
                let width = stroke.path.first.map { Int($0.size.width.rounded()) } ?? PencilKitInk.defaultWidth
                _ = try engine.addInkAnnotation(
                    pdfId: document.id,
                    page: index,
                    draft: InkStrokeDraft(
                        color: HexColor.hex(stroke.ink.color),
                        width: min(1000, max(1, width)),
                        points: try Ink.encode(points)
                    )
                )
            }
        }
        drawing = PKDrawing()
    }
}

/// Lets the SwiftUI layer talk to the `PDFView` it does not own — reading the
/// current selection and page, which have no SwiftUI equivalent.
@MainActor
final class PDFViewHandle: ObservableObject {
    weak var view: PDFView?
}

/// Hosts a `PDFView` and keeps the notebook's annotations drawn on it.
struct PDFDocumentView: UIViewRepresentable {
    let document: PDFDocument
    let annotations: [Annotation]
    let strokes: [InkStroke]
    let handle: PDFViewHandle

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.usePageViewController(false)
        view.document = document
        handle.view = view
        apply()
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        if view.document !== document { view.document = document }
        handle.view = view
        apply()
    }

    /// Re-applies the whole set. The bridge removes what it previously added
    /// first, so this is idempotent and a deleted annotation actually leaves
    /// the page.
    private func apply() {
        try? PDFAnnotationBridge.apply(annotations: annotations, strokes: strokes, to: document)
    }
}
#endif
