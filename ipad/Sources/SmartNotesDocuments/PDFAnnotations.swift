import CoreGraphics
import Foundation
import PDFKit
import SmartNotesKit

/// Bridges the shared `Annotation` record to PDFKit and back.
///
/// The operation log is the source of truth, not the PDF file: a highlight is
/// durable because it is an operation, and the PDF on disk stays exactly the
/// bytes the server hashed. This bridge is what puts those records on a page
/// for viewing, and what reads a page back when a PDF is exported or imported.
///
/// Geometry, colour and text round-trip through real PDF annotation
/// properties. Only the fields with no PDF equivalent — our id, our `kind`,
/// the stroke it points at, and its timestamps — travel in private annotation
/// keys. PDFKit drops `/NM` on write, so it cannot be used to carry the id.
public enum PDFAnnotationBridge {
    public static let idKey = PDFAnnotationKey(rawValue: "SmartNotesId")
    public static let kindKey = PDFAnnotationKey(rawValue: "SmartNotesKind")
    public static let strokeKey = PDFAnnotationKey(rawValue: "SmartNotesStroke")
    public static let createdKey = PDFAnnotationKey(rawValue: "SmartNotesCreated")
    public static let updatedKey = PDFAnnotationKey(rawValue: "SmartNotesUpdated")

    /// The rectangle in an `Annotation` is in PDF user space with the origin
    /// at the bottom-left of its page — PDFKit's own coordinate system — so a
    /// highlight placed on one device lands on the same words on another
    /// without a page-height-dependent flip.
    public static func subtype(for kind: AnnotationKind) -> PDFAnnotationSubtype {
        switch kind {
        case .highlight: return .highlight
        case .note: return .text
        case .ink: return .ink
        }
    }

    public static func kind(for subtype: String) -> AnnotationKind? {
        switch subtype.replacingOccurrences(of: "/", with: "") {
        case "Highlight": return .highlight
        case "Text": return .note
        case "Ink": return .ink
        default: return nil
        }
    }

    // MARK: - Model to PDFKit

    /// Builds the PDFKit annotation for one record. `stroke` is required for
    /// an ink annotation and ignored otherwise.
    public static func pdfAnnotation(for annotation: Annotation, stroke: InkStroke?) throws -> PDFAnnotation {
        let bounds = try self.bounds(for: annotation, stroke: stroke)
        let pdfAnnotation = PDFAnnotation(bounds: bounds, forType: subtype(for: annotation.kind), withProperties: nil)
        if let color = HexColor.color(annotation.color) { pdfAnnotation.color = color }
        if let text = annotation.text { pdfAnnotation.contents = text }

        if annotation.kind == .ink, let stroke {
            let points = try Ink.decode(stroke.points).map { CGPoint(x: $0.x, y: $0.y) }
            pdfAnnotation.add(polyline(points))
            pdfAnnotation.border = PDFBorder()
            pdfAnnotation.border?.lineWidth = CGFloat(stroke.width)
        }

        pdfAnnotation.setValue(annotation.id, forAnnotationKey: idKey)
        pdfAnnotation.setValue(annotation.kind.rawValue, forAnnotationKey: kindKey)
        pdfAnnotation.setValue(String(annotation.createdAt), forAnnotationKey: createdKey)
        pdfAnnotation.setValue(String(annotation.updatedAt), forAnnotationKey: updatedKey)
        if let strokeId = annotation.strokeId { pdfAnnotation.setValue(strokeId, forAnnotationKey: strokeKey) }
        return pdfAnnotation
    }

    /// An ink annotation has no rectangle of its own — its extent is the
    /// stroke's — so one is derived rather than stored, which keeps the two
    /// from disagreeing.
    static func bounds(for annotation: Annotation, stroke: InkStroke?) throws -> CGRect {
        if let rect = annotation.rect {
            return CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height)
        }
        guard let stroke, !stroke.points.isEmpty else { return .zero }
        let points = try Ink.decode(stroke.points)
        let xs = points.map(\.x)
        let ys = points.map(\.y)
        let pad = Double(stroke.width)
        let minX = (xs.min() ?? 0) - pad
        let minY = (ys.min() ?? 0) - pad
        return CGRect(
            x: max(0, minX),
            y: max(0, minY),
            width: (xs.max() ?? 0) - minX + pad,
            height: (ys.max() ?? 0) - minY + pad
        )
    }

    /// Draws the notebook's annotations onto an open document. Any annotation
    /// this bridge previously added is removed first, so applying twice does
    /// not duplicate anything.
    public static func apply(annotations: [Annotation], strokes: [InkStroke], to document: PDFDocument) throws {
        removeManaged(from: document)
        let strokesById = Dictionary(strokes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for annotation in annotations {
            guard annotation.page >= 0, annotation.page < document.pageCount, let page = document.page(at: annotation.page) else {
                continue
            }
            let stroke = annotation.strokeId.flatMap { strokesById[$0] }
            page.addAnnotation(try pdfAnnotation(for: annotation, stroke: stroke))
        }
    }

    public static func removeManaged(from document: PDFDocument) {
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { continue }
            for annotation in page.annotations where annotation.value(forAnnotationKey: idKey) is String {
                page.removeAnnotation(annotation)
            }
        }
    }

    // MARK: - PDFKit to model

    /// Reads one PDFKit annotation back into a record. Returns nil for an
    /// annotation this bridge did not write — a PDF may arrive with the
    /// author's own annotations, and adopting those silently would put
    /// unreviewed content into the notebook's operation log.
    public static func annotation(
        from pdfAnnotation: PDFAnnotation,
        page: Int,
        notebookId: String,
        pdfId: String
    ) -> Annotation? {
        guard let id = pdfAnnotation.value(forAnnotationKey: idKey) as? String else { return nil }
        let declared = (pdfAnnotation.value(forAnnotationKey: kindKey) as? String).flatMap(AnnotationKind.init(rawValue:))
        guard let kind = declared ?? self.kind(for: pdfAnnotation.type ?? "") else { return nil }

        let bounds = pdfAnnotation.bounds
        let rect = kind == .ink
            ? nil
            : Rect(
                x: max(0, Double(bounds.origin.x)),
                y: max(0, Double(bounds.origin.y)),
                width: max(0, Double(bounds.size.width)),
                height: max(0, Double(bounds.size.height))
            )
        let text = pdfAnnotation.contents.flatMap { $0.isEmpty ? nil : $0 }
        let createdAt = (pdfAnnotation.value(forAnnotationKey: createdKey) as? String).flatMap(Int64.init) ?? 0
        let updatedAt = (pdfAnnotation.value(forAnnotationKey: updatedKey) as? String).flatMap(Int64.init) ?? createdAt

        return Annotation(
            id: id,
            pdfId: pdfId,
            notebookId: notebookId,
            page: page,
            kind: kind,
            rect: rect,
            color: HexColor.hex(pdfAnnotation.color),
            text: text,
            strokeId: pdfAnnotation.value(forAnnotationKey: strokeKey) as? String,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }

    public static func extract(from document: PDFDocument, notebookId: String, pdfId: String) -> [Annotation] {
        var out: [Annotation] = []
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { continue }
            for pdfAnnotation in page.annotations {
                if let annotation = annotation(from: pdfAnnotation, page: index, notebookId: notebookId, pdfId: pdfId) {
                    out.append(annotation)
                }
            }
        }
        return out.sorted { $0.page != $1.page ? $0.page < $1.page : $0.id < $1.id }
    }
}
