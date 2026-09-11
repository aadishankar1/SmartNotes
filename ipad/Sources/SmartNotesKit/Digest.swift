import CryptoKit
import Foundation

/// Content addressing, matching `shared/src/hash.ts`.
public enum Digest {
    public static func sha256Hex(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    public static func sha256Hex(_ text: String) -> String {
        sha256Hex(Data(text.utf8))
    }

    /// Content address of any JSON value, taken over its canonical bytes.
    public static func hashJSON(_ value: JSONValue) throws -> String {
        sha256Hex(try value.canonicalData())
    }

    public static func hashJSON<T: Encodable>(encoding value: T) throws -> String {
        try hashJSON(JSONValue(encoding: value))
    }
}
