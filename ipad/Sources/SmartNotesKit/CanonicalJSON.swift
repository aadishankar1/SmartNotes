import Foundation

/// Deterministic JSON, byte-compatible with `shared/src/json.ts`.
///
/// Every digest, operation id and stored record in SmartNotes is taken over
/// canonical bytes, so the iPad client has to agree with the server about them
/// exactly rather than approximately.
public enum JSONValue: Hashable, Sendable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    /// Integral doubles collapse to `.int` so that value equality means the
    /// same thing as canonical-byte equality.
    public static func number(_ value: Double) -> JSONValue {
        guard value.isFinite, value == value.rounded(), abs(value) < 9_007_199_254_740_992 else {
            return .double(value)
        }
        return .int(Int64(value))
    }
}

public struct SerializationError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

// MARK: - Accessors

extension JSONValue {
    public var isNull: Bool { if case .null = self { return true } else { return false } }

    public var stringValue: String? { if case let .string(value) = self { return value } else { return nil } }

    public var boolValue: Bool? { if case let .bool(value) = self { return value } else { return nil } }

    public var intValue: Int64? {
        switch self {
        case let .int(value): return value
        case let .double(value) where value == value.rounded(): return Int64(value)
        default: return nil
        }
    }

    public var doubleValue: Double? {
        switch self {
        case let .int(value): return Double(value)
        case let .double(value): return value
        default: return nil
        }
    }

    public var arrayValue: [JSONValue]? { if case let .array(value) = self { return value } else { return nil } }

    public var objectValue: [String: JSONValue]? { if case let .object(value) = self { return value } else { return nil } }

    public subscript(key: String) -> JSONValue? {
        guard case let .object(members) = self else { return nil }
        return members[key]
    }
}

// MARK: - Canonical form

extension JSONValue {
    /// Object keys sorted by UTF-16 code unit, no insignificant whitespace,
    /// `-0` normalised to `0`, and non-finite numbers refused rather than
    /// silently written as `null`.
    public func canonicalString() throws -> String {
        var out = ""
        try write(into: &out, path: "$")
        return out
    }

    public func canonicalData() throws -> Data {
        Data(try canonicalString().utf8)
    }

    private func write(into out: inout String, path: String) throws {
        switch self {
        case .null:
            out += "null"
        case let .bool(value):
            out += value ? "true" : "false"
        case let .int(value):
            out += String(value)
        case let .double(value):
            guard value.isFinite else { throw SerializationError("non-finite number at \(path)") }
            out += JSONValue.formatDouble(value)
        case let .string(value):
            JSONValue.writeString(value, into: &out)
        case let .array(items):
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                try item.write(into: &out, path: "\(path)[\(index)]")
            }
            out += "]"
        case let .object(members):
            out += "{"
            let keys = members.keys.sorted(by: JSONValue.utf16Ascending)
            for (index, key) in keys.enumerated() {
                if index > 0 { out += "," }
                JSONValue.writeString(key, into: &out)
                out += ":"
                try members[key]!.write(into: &out, path: "\(path).\(key)")
            }
            out += "}"
        }
    }

    /// `JSON.stringify` prints an integral double without a fractional part;
    /// Swift's `description` does not, so integral values are printed as
    /// integers and everything else uses the shortest round-tripping form.
    static func formatDouble(_ value: Double) -> String {
        if value == 0 { return "0" }
        if value == value.rounded(), abs(value) < 9_007_199_254_740_992 { return String(Int64(value)) }
        return String(value)
    }

    static func writeString(_ value: String, into out: inout String) {
        out += "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{09}": out += "\\t"
            case "\u{0A}": out += "\\n"
            case "\u{0C}": out += "\\f"
            case "\u{0D}": out += "\\r"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }

    /// JavaScript's default sort compares UTF-16 code units; Swift's `<`
    /// compares Unicode scalars, which differ above the BMP.
    static func utf16Ascending(_ lhs: String, _ rhs: String) -> Bool {
        var left = lhs.utf16.makeIterator()
        var right = rhs.utf16.makeIterator()
        while true {
            switch (left.next(), right.next()) {
            case (nil, nil): return false
            case (nil, _): return true
            case (_, nil): return false
            case let (a?, b?): if a != b { return a < b }
            }
        }
    }
}

// MARK: - Bridging

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int64.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "unsupported JSON value")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case let .bool(value): try container.encode(value)
        case let .int(value): try container.encode(value)
        case let .double(value): try container.encode(value)
        case let .string(value): try container.encode(value)
        case let .array(value): try container.encode(value)
        case let .object(value): try container.encode(value)
        }
    }
}

extension JSONValue {
    public init(parsing data: Data) throws {
        let object = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        self = try JSONValue(foundation: object)
    }

    public init(parsing text: String) throws {
        try self.init(parsing: Data(text.utf8))
    }

    /// Round-trips through JSON so that number types come back the way the
    /// wire saw them, which is what canonicalization is defined over.
    public init<T: Encodable>(encoding value: T) throws {
        let encoder = JSONEncoder()
        self = try JSONValue(parsing: try encoder.encode(value))
    }

    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: try canonicalData())
    }

    private init(foundation object: Any) throws {
        switch object {
        case is NSNull:
            self = .null
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else if JSONValue.isIntegerNumber(number) {
                self = .int(number.int64Value)
            } else {
                self = .number(number.doubleValue)
            }
        case let text as String:
            self = .string(text)
        case let items as [Any]:
            self = .array(try items.map { try JSONValue(foundation: $0) })
        case let members as [String: Any]:
            var out: [String: JSONValue] = [:]
            out.reserveCapacity(members.count)
            for (key, value) in members { out[key] = try JSONValue(foundation: value) }
            self = .object(out)
        default:
            throw SerializationError("unserializable value of type \(type(of: object))")
        }
    }

    private static func isIntegerNumber(_ number: NSNumber) -> Bool {
        switch UnicodeScalar(UInt8(bitPattern: number.objCType.pointee)) {
        case "c", "C", "s", "S", "i", "I", "l", "L", "q", "Q", "B":
            return true
        default:
            return false
        }
    }
}

extension JSONValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
}

extension JSONValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int64) { self = .int(value) }
}
