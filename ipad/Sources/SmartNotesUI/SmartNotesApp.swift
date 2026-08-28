#if canImport(UIKit)
import SmartNotesKit
import SwiftUI

/// The iPad app.
///
/// Startup is a state, not an assumption: creating the on-disk store can fail
/// (a full disk, a restricted container), and the app says so instead of
/// launching into a window that cannot save anything.
@main
public struct SmartNotesApp: App {
    @StateObject private var boot = Boot()

    public init() {}

    public var body: some Scene {
        WindowGroup {
            Group {
                switch boot.state {
                case .starting:
                    MessageView(
                        symbol: "arrow.triangle.2.circlepath",
                        title: "Opening SmartNotes",
                        detail: "Loading your notebooks from this iPad.",
                        inProgress: true
                    )
                case let .failed(message):
                    MessageView(
                        symbol: "exclamationmark.triangle",
                        title: "SmartNotes could not open its library",
                        detail: message,
                        action: ("Try again", { boot.start() })
                    )
                case let .ready(library):
                    RootView(library: library)
                }
            }
            .task { if boot.isIdle { boot.start() } }
        }
    }
}

@MainActor
final class Boot: ObservableObject {
    enum State {
        case starting
        case ready(Library)
        case failed(String)
    }

    @Published private(set) var state: State = .starting
    private var started = false

    var isIdle: Bool { !started }

    func start() {
        started = true
        state = .starting
        do {
            let library = try Library(store: try LocalStore(root: try LocalStore.defaultRoot()))
            try library.restore()
            state = .ready(library)
        } catch {
            state = .failed("\(error)")
        }
    }
}
#endif
