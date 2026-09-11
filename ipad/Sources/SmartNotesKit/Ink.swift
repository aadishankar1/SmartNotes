import Foundation

/// Ink stroke encoding, matching `shared/src/ink.ts`.
///
/// Pen input arrives as floats, and floats from two devices never serialise to
/// the same bytes. Strokes are quantised on the way in: position to hundredths
/// of a point, pressure to thousandths, time to milliseconds relative to the
/// first sample.
public enum Ink {
    public static let positionScale: Double = 100
    public static let pressureScale: Double = 1000
    public static let stride = 4

    public struct Point: Hashable, Sendable {
        public var x: Double
        public var y: Double
        /// 0...1
        public var pressure: Double
        /// Milliseconds since the first sample of the stroke.
        public var t: Double

        public init(x: Double, y: Double, pressure: Double, t: Double) {
            self.x = x
            self.y = y
            self.pressure = pressure
            self.t = t
        }
    }

    public struct InkError: Error, CustomStringConvertible {
        public let description: String
        public init(_ description: String) { self.description = description }
    }

    public static func encode(_ points: [Point]) throws -> [Int] {
        var out: [Int] = []
        out.reserveCapacity(points.count * stride)
        let origin = points.first?.t ?? 0
        for point in points {
            out.append(try quantize(point.x, scale: positionScale, label: "x"))
            out.append(try quantize(point.y, scale: positionScale, label: "y"))
            out.append(try quantize(min(1, max(0, point.pressure)), scale: pressureScale, label: "pressure"))
            out.append(max(0, try quantize(point.t - origin, scale: 1, label: "t")))
        }
        return out
    }

    public static func decode(_ points: [Int]) throws -> [Point] {
        guard points.count % stride == 0 else {
            throw InkError("ink stroke length \(points.count) is not a multiple of \(stride)")
        }
        var out: [Point] = []
        out.reserveCapacity(points.count / stride)
        for index in Swift.stride(from: 0, to: points.count, by: stride) {
            out.append(
                Point(
                    x: Double(points[index]) / positionScale,
                    y: Double(points[index + 1]) / positionScale,
                    pressure: Double(points[index + 2]) / pressureScale,
                    t: Double(points[index + 3])
                )
            )
        }
        return out
    }

    /// Number of samples in an encoded stroke.
    public static func sampleCount(_ points: [Int]) -> Int {
        points.count / stride
    }

    /// Rounds halves towards positive infinity, which is what `Math.round`
    /// does; Swift's `rounded()` rounds them away from zero and would disagree
    /// with the server on negative coordinates.
    private static func quantize(_ value: Double, scale: Double, label: String) throws -> Int {
        guard value.isFinite else { throw InkError("non-finite \(label) in ink stroke") }
        return Int((value * scale + 0.5).rounded(.down))
    }
}
