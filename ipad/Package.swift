// swift-tools-version: 5.9
import PackageDescription

/// SmartNotes for iPad.
///
/// `SmartNotesKit` is the contract, the offline store and the sync engine; it
/// has no UI framework dependency so it compiles — and its tests run — on any
/// Apple platform. `SmartNotesDocuments` bridges the shared document model to
/// PDFKit and PencilKit, both of which exist on macOS as well as iOS, so the
/// round trips are testable without a simulator. `SmartNotesUI` is the SwiftUI
/// iPad surface and is compiled only for iOS.
let package = Package(
    name: "SmartNotes",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "SmartNotesKit", targets: ["SmartNotesKit"]),
        .library(name: "SmartNotesDocuments", targets: ["SmartNotesDocuments"]),
        .library(name: "SmartNotesUI", targets: ["SmartNotesUI"]),
    ],
    targets: [
        .target(name: "SmartNotesKit"),
        .target(name: "SmartNotesDocuments", dependencies: ["SmartNotesKit"]),
        .target(name: "SmartNotesUI", dependencies: ["SmartNotesKit", "SmartNotesDocuments"]),
        // A plain executable rather than an XCTest bundle: the same suite then
        // runs under `swift run SmartNotesTests` and under a direct swiftc
        // build, which is the only option in sandboxes that block SwiftPM.
        .executableTarget(name: "SmartNotesTests", dependencies: ["SmartNotesKit", "SmartNotesDocuments"]),
    ]
)
