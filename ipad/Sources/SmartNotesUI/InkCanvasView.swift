#if canImport(UIKit)
import PencilKit
import SwiftUI

/// A PencilKit canvas bound to a `PKDrawing`.
///
/// The drawing, not the view, is the value that travels: the notebook stores
/// strokes, so what SwiftUI owns here is a `PKDrawing` that
/// `PencilKitInk` converts in both directions. `allowsFingerDrawing` stays on
/// so the app is usable without a Pencil — the sandboxed test machine has none,
/// and neither does every reviewer.
struct InkCanvasView: UIViewRepresentable {
    @Binding var drawing: PKDrawing
    var isDrawing: Bool = true
    var showsToolPicker: Bool = true

    func makeUIView(context: Context) -> PKCanvasView {
        let canvas = PKCanvasView()
        canvas.drawing = drawing
        canvas.delegate = context.coordinator
        canvas.drawingPolicy = .anyInput
        canvas.backgroundColor = .clear
        canvas.isOpaque = false
        canvas.alwaysBounceVertical = false

        if showsToolPicker {
            let picker = context.coordinator.toolPicker
            picker.addObserver(canvas)
            picker.setVisible(true, forFirstResponder: canvas)
            DispatchQueue.main.async { canvas.becomeFirstResponder() }
        }
        return canvas
    }

    func updateUIView(_ canvas: PKCanvasView, context: Context) {
        // The coordinator holds a copy of this struct, so it needs the current
        // one to write through the current binding.
        context.coordinator.parent = self
        // Only push a drawing the canvas does not already have; assigning on
        // every update would interrupt a stroke in progress.
        if canvas.drawing != drawing { canvas.drawing = drawing }
        canvas.isUserInteractionEnabled = isDrawing
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, PKCanvasViewDelegate {
        let toolPicker = PKToolPicker()
        var parent: InkCanvasView

        init(_ parent: InkCanvasView) { self.parent = parent }

        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            parent.drawing = canvasView.drawing
        }
    }
}
#endif
