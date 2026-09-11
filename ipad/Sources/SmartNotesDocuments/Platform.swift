import CoreGraphics
import Foundation

#if canImport(UIKit)
import UIKit
public typealias PlatformColor = UIColor
public typealias PlatformBezierPath = UIBezierPath
#else
import AppKit
public typealias PlatformColor = NSColor
public typealias PlatformBezierPath = NSBezierPath
#endif

/// The shared contract stores colours as lowercase `#rrggbb`, which is what
/// its schema validates. PDFKit and PencilKit both hand back floats that have
/// been through a 32-bit colour component, so conversion rounds rather than
/// truncates — otherwise `#ffd60a` comes back as `#ffd509`.
public enum HexColor {
    public static let defaultInk = "#1f2933"
    public static let defaultHighlight = "#ffd60a"

    public static func color(_ hex: String) -> PlatformColor? {
        var text = Substring(hex)
        guard text.first == "#" else { return nil }
        text = text.dropFirst()
        guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
        return PlatformColor(
            red: CGFloat((value >> 16) & 0xff) / 255,
            green: CGFloat((value >> 8) & 0xff) / 255,
            blue: CGFloat(value & 0xff) / 255,
            alpha: 1
        )
    }

    public static func hex(_ color: PlatformColor) -> String {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        #if canImport(UIKit)
        guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return defaultInk }
        #else
        guard let srgb = color.usingColorSpace(.sRGB) else { return defaultInk }
        srgb.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        #endif
        return format(red, green, blue)
    }

    static func format(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat) -> String {
        func channel(_ value: CGFloat) -> Int {
            Int((min(1, max(0, value)) * 255).rounded())
        }
        return String(format: "#%02x%02x%02x", channel(red), channel(green), channel(blue))
    }
}

/// `NSBezierPath` and `UIBezierPath` disagree on the name of the one method
/// this file needs, so the difference is confined here.
public func polyline(_ points: [CGPoint]) -> PlatformBezierPath {
    let path = PlatformBezierPath()
    guard let first = points.first else { return path }
    path.move(to: first)
    for point in points.dropFirst() {
        #if canImport(UIKit)
        path.addLine(to: point)
        #else
        path.line(to: point)
        #endif
    }
    return path
}
