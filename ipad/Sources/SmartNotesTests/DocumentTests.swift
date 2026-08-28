import CoreGraphics
import Foundation
import PDFKit
import PencilKit
import SmartNotesDocuments
import SmartNotesKit

/// PDF annotations and PencilKit ink, through the shared document model.
///
/// "Survives reopening" is tested literally: the PDF is serialised to bytes and
/// parsed back, the drawing is archived and unarchived, and the notebook is
/// closed and reopened from disk.
func runDocumentTests(_ runner: TestRunner) {
    runner.suite("documents")

    func blankDocument(pages: Int = 3) -> PDFDocument {
        let document = PDFDocument()
        for _ in 0..<pages { document.insert(PDFPage(), at: document.pageCount) }
        return document
    }

    runner.test("hex colours survive a trip through a platform colour") {
        for hex in ["#ffd60a", "#1f2933", "#000000", "#ffffff", "#2f80ed"] {
            guard let color = HexColor.color(hex) else { throw Failure("could not parse \(hex)") }
            try expectEqual(HexColor.hex(color), hex, "round trip for \(hex)")
        }
        try expect(HexColor.color("ffd60a") == nil, "a colour without a leading # is not contract-shaped")
        try expect(HexColor.color("#fff") == nil, "a three-digit colour is not contract-shaped")
    }

    runner.test("a highlight survives writing the PDF out and reading it back") {
        let annotation = try Fixtures.decode(Annotation.self, "annotation")
        let stroke = try Fixtures.decode(InkStroke.self, "stroke")
        let document = blankDocument()
        try PDFAnnotationBridge.apply(annotations: [annotation], strokes: [stroke], to: document)

        guard let bytes = document.dataRepresentation(), let reopened = PDFDocument(data: bytes) else {
            throw Failure("could not serialise the document")
        }
        let extracted = PDFAnnotationBridge.extract(from: reopened, notebookId: annotation.notebookId, pdfId: annotation.pdfId)
        try expectEqual(extracted.count, 1, "annotation count after reopening")

        let back = extracted[0]
        try expectEqual(back.id, annotation.id, "id")
        try expectEqual(back.page, annotation.page, "page")
        try expectEqual(back.kind, annotation.kind, "kind")
        try expectEqual(back.color, annotation.color, "colour")
        try expectEqual(back.text, annotation.text, "text")
        try expectEqual(back.strokeId, annotation.strokeId, "strokeId")
        try expectEqual(back.createdAt, annotation.createdAt, "createdAt")
        try expectEqual(back.updatedAt, annotation.updatedAt, "updatedAt")
        try expectEqual(back.rect, annotation.rect, "rect")
        // The whole record, not just the fields checked above.
        try expectEqual(
            try JSONValue(encoding: back).canonicalString(),
            try JSONValue(encoding: annotation).canonicalString(),
            "the reopened annotation is byte-identical to the original"
        )
    }

    runner.test("an ink annotation keeps its stroke reference and derives its bounds") {
        let stroke = try Fixtures.decode(InkStroke.self, "stroke")
        let annotation = Annotation(
            id: "anno_ink", pdfId: "pdf_syllabus", notebookId: "nb_field", page: 2,
            kind: .ink, rect: nil, color: stroke.color, text: nil, strokeId: stroke.id,
            createdAt: 1_767_226_100_000, updatedAt: 1_767_226_100_000
        )
        let document = blankDocument()
        try PDFAnnotationBridge.apply(annotations: [annotation], strokes: [stroke], to: document)

        // The bounds have to cover the stroke, since an ink record carries no
        // rectangle of its own.
        let points = try Ink.decode(stroke.points)
        guard let drawn = document.page(at: 2)?.annotations.first else { throw Failure("no annotation was added") }
        try expect(drawn.bounds.contains(CGPoint(x: points[0].x, y: points[0].y)), "bounds must cover the first sample")
        try expect(drawn.bounds.contains(CGPoint(x: points[3].x, y: points[3].y)), "bounds must cover the last sample")

        guard let bytes = document.dataRepresentation(), let reopened = PDFDocument(data: bytes) else {
            throw Failure("could not serialise the document")
        }
        let extracted = PDFAnnotationBridge.extract(from: reopened, notebookId: "nb_field", pdfId: "pdf_syllabus")
        try expectEqual(extracted.count, 1, "annotation count")
        try expectEqual(extracted[0].kind, .ink, "kind")
        try expectEqual(extracted[0].strokeId, stroke.id, "strokeId")
        try expect(extracted[0].rect == nil, "an ink annotation has no rectangle of its own")
    }

    runner.test("annotations the app did not write are left alone") {
        let document = blankDocument()
        let foreign = PDFAnnotation(bounds: CGRect(x: 10, y: 10, width: 20, height: 20), forType: .highlight, withProperties: nil)
        document.page(at: 0)?.addAnnotation(foreign)

        let extracted = PDFAnnotationBridge.extract(from: document, notebookId: "nb_field", pdfId: "pdf_syllabus")
        try expectEqual(extracted.count, 0, "an annotation from the PDF's author must not enter the notebook")

        // Re-applying must not remove it either — it is not ours to delete.
        try PDFAnnotationBridge.apply(annotations: [], strokes: [], to: document)
        try expectEqual(document.page(at: 0)?.annotations.count, 1, "the author's annotation stays")
    }

    runner.test("applying the same annotations twice does not duplicate them") {
        let annotation = try Fixtures.decode(Annotation.self, "annotation")
        let stroke = try Fixtures.decode(InkStroke.self, "stroke")
        let document = blankDocument()
        try PDFAnnotationBridge.apply(annotations: [annotation], strokes: [stroke], to: document)
        try PDFAnnotationBridge.apply(annotations: [annotation], strokes: [stroke], to: document)
        try expectEqual(document.page(at: 2)?.annotations.count, 1, "annotation count after re-applying")
    }

    runner.test("an annotation on a page the document does not have is skipped, not crashed on") {
        var annotation = try Fixtures.decode(Annotation.self, "annotation")
        annotation.page = 99
        let document = blankDocument()
        try PDFAnnotationBridge.apply(annotations: [annotation], strokes: [], to: document)
        try expectEqual(PDFAnnotationBridge.extract(from: document, notebookId: "nb_field", pdfId: "pdf_syllabus").count, 0, "skipped")
    }

    runner.test("a contract stroke becomes a PencilKit stroke and comes back unchanged") {
        let stroke = try Fixtures.decode(InkStroke.self, "stroke")
        let pkStroke = try PencilKitInk.pkStroke(from: stroke)
        let draft = try PencilKitInk.draft(from: pkStroke)

        try expectEqual(draft.points, stroke.points, "quantised points")
        try expectEqual(draft.color, stroke.color, "colour")
        try expectEqual(draft.width, stroke.width, "width")
    }

    runner.test("a drawing survives PencilKit's own archive") {
        let stroke = try Fixtures.decode(InkStroke.self, "stroke")
        let drawing = try PencilKitInk.drawing(from: [stroke])
        try expectEqual(drawing.strokes.count, 1, "stroke count")

        let reopened = try PKDrawing(data: drawing.dataRepresentation())
        let drafts = try PencilKitInk.drafts(from: reopened)
        try expectEqual(drafts.count, 1, "stroke count after reopening")
        try expectEqual(drafts[0].points, stroke.points, "points after reopening")
        try expectEqual(drafts[0].color, stroke.color, "colour after reopening")
        try expectEqual(drafts[0].width, stroke.width, "width after reopening")
    }

    runner.test("an empty stroke is refused rather than archived as a dot") {
        let stroke = InkStroke(
            id: "ink_empty", notebookId: "nb_field", targetKind: .note, targetId: "note_x",
            page: nil, color: "#1f2933", width: 3, points: [], createdAt: 0
        )
        try expectThrows("empty stroke") { _ = try PencilKitInk.pkStroke(from: stroke) }
    }

    runner.test("handwriting saved to a notebook survives closing and reopening it") {
        let temporary = try TemporaryDirectory()
        let stroke = try Fixtures.decode(InkStroke.self, "stroke")
        let original = try PencilKitInk.drawing(from: [stroke])

        do {
            let engine = try SyncEngine(
                notebookId: "nb_field",
                store: try LocalStore(root: temporary.url, fsync: false),
                api: APIClient(transport: FakeTransport(server: FakeServer(notebookId: "nb_field"))),
                deviceId: "dev_ipad",
                now: { 1_767_226_100_000 }
            )
            let saved = try PencilKitInk.save(original, to: engine, targetKind: .note, targetId: "note_kickoff")
            try expectEqual(saved.count, 1, "stroke count on save")
        }

        // Reopened from disk, with no in-memory state carried over.
        let engine = try SyncEngine(
            notebookId: "nb_field",
            store: try LocalStore(root: temporary.url, fsync: false),
            api: APIClient(transport: FakeTransport(server: FakeServer(notebookId: "nb_field"))),
            deviceId: "dev_ipad"
        )
        let reloaded = try PencilKitInk.load(from: engine, targetKind: .note, targetId: "note_kickoff")
        try expectEqual(reloaded.strokes.count, 1, "stroke count after reopening")
        try expectEqual(
            try PencilKitInk.drafts(from: reloaded),
            try PencilKitInk.drafts(from: original),
            "the reopened drawing is the drawing that was saved"
        )
    }

    runner.test("PDF annotations survive closing and reopening the notebook") {
        let temporary = try TemporaryDirectory()
        let stroke = try Fixtures.decode(InkStroke.self, "stroke")
        var highlightId = ""
        var inkAnnotationId = ""

        do {
            let engine = try SyncEngine(
                notebookId: "nb_field",
                store: try LocalStore(root: temporary.url, fsync: false),
                api: APIClient(transport: FakeTransport(server: FakeServer(notebookId: "nb_field"))),
                deviceId: "dev_ipad",
                now: { 1_767_226_100_000 }
            )
            highlightId = try engine.addHighlight(
                pdfId: "pdf_syllabus", page: 2,
                rect: Rect(x: 72, y: 320.5, width: 180, height: 14),
                text: "lab report due"
            ).id
            inkAnnotationId = try engine.addInkAnnotation(
                pdfId: "pdf_syllabus", page: 2,
                draft: InkStrokeDraft(color: stroke.color, width: stroke.width, points: stroke.points)
            ).0.id
        }

        let engine = try SyncEngine(
            notebookId: "nb_field",
            store: try LocalStore(root: temporary.url, fsync: false),
            api: APIClient(transport: FakeTransport(server: FakeServer(notebookId: "nb_field"))),
            deviceId: "dev_ipad"
        )
        let annotations = try engine.annotations(pdfId: "pdf_syllabus")
        try expectEqual(annotations.count, 2, "annotations after reopening")
        try expect(annotations.contains { $0.id == highlightId && $0.kind == .highlight }, "the highlight survived")
        try expect(annotations.contains { $0.id == inkAnnotationId && $0.kind == .ink }, "the ink annotation survived")

        // And they still render onto a page.
        let document = blankDocument()
        try PDFAnnotationBridge.apply(
            annotations: annotations,
            strokes: try engine.strokes(targetKind: .pdf, targetId: "pdf_syllabus"),
            to: document
        )
        try expectEqual(document.page(at: 2)?.annotations.count, 2, "both annotations drawn on page 2")
    }
}
