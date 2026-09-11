import CoreGraphics
import Foundation
import PencilKit
import SmartNotesKit

/// Bridges PencilKit drawings to the shared ink model.
///
/// One `PKStroke` becomes one `InkStroke`. The mapping is over the stroke's
/// *control* points, not its rendered interpolation, because control points are
/// what `PKDrawing`'s own archive preserves exactly; sampling the rendered
/// curve instead would make every save-and-reopen cycle drift.
///
/// Quantisation is the shared contract's, not PencilKit's: position to
/// hundredths of a point, pressure to thousandths, time to milliseconds. A
/// stroke drawn on iPad and one replayed on another device therefore serialise
/// to identical bytes.
public enum PencilKitInk {
    /// PencilKit measures force against a device-specific maximum; the contract
    /// stores 0...1. `PKStrokePoint.force` is already normalised for Pencil
    /// input, so this is a clamp rather than a scale.
    public static let defaultWidth = 3

    public struct InkError: Error, CustomStringConvertible {
        public let description: String
        public init(_ description: String) { self.description = description }
    }

    // MARK: - PencilKit to the contract

    public static func drafts(from drawing: PKDrawing) throws -> [InkStrokeDraft] {
        try drawing.strokes.map { try draft(from: $0) }
    }

    public static func draft(from stroke: PKStroke) throws -> InkStrokeDraft {
        let transform = stroke.transform
        let points = stroke.path.map { point -> Ink.Point in
            let location = point.location.applying(transform)
            return Ink.Point(
                x: Double(location.x),
                y: Double(location.y),
                pressure: min(1, max(0, Double(point.force))),
                t: point.timeOffset * 1000
            )
        }
        let width = stroke.path.first.map { Int(($0.size.width).rounded()) } ?? defaultWidth
        return InkStrokeDraft(
            color: HexColor.hex(stroke.ink.color),
            width: min(1000, max(1, width)),
            points: try Ink.encode(points)
        )
    }

    // MARK: - The contract to PencilKit

    public static func drawing(from strokes: [InkStroke]) throws -> PKDrawing {
        PKDrawing(strokes: try strokes.map { try pkStroke(from: $0) })
    }

    public static func pkStroke(from stroke: InkStroke) throws -> PKStroke {
        let points = try Ink.decode(stroke.points)
        guard !points.isEmpty else { throw InkError("ink stroke \(stroke.id) has no points") }
        let size = CGSize(width: CGFloat(stroke.width), height: CGFloat(stroke.width))
        let controlPoints = points.map { point in
            PKStrokePoint(
                location: CGPoint(x: point.x, y: point.y),
                timeOffset: point.t / 1000,
                size: size,
                opacity: 1,
                force: CGFloat(point.pressure),
                azimuth: 0,
                altitude: .pi / 2
            )
        }
        let ink = PKInk(.pen, color: HexColor.color(stroke.color) ?? HexColor.color(HexColor.defaultInk)!)
        // A fixed creation date keeps the archive a pure function of the
        // stroke, so re-encoding an unchanged drawing does not produce new
        // bytes and a spurious change.
        let path = PKStrokePath(controlPoints: controlPoints, creationDate: Date(timeIntervalSince1970: TimeInterval(stroke.createdAt) / 1000))
        return PKStroke(ink: ink, path: path)
    }

    // MARK: - Whole-canvas helpers

    /// Saves a canvas into the notebook. The engine diffs it against what is
    /// already there, so an unchanged drawing writes no operations.
    @discardableResult
    public static func save(
        _ drawing: PKDrawing,
        to engine: SyncEngine,
        targetKind: StrokeTargetKind,
        targetId: String,
        page: Int? = nil
    ) throws -> [InkStroke] {
        try engine.setInk(targetKind: targetKind, targetId: targetId, page: page, drafts: try drafts(from: drawing))
    }

    public static func load(
        from engine: SyncEngine,
        targetKind: StrokeTargetKind,
        targetId: String,
        page: Int? = nil
    ) throws -> PKDrawing {
        try drawing(from: try engine.strokes(targetKind: targetKind, targetId: targetId, page: page))
    }
}
