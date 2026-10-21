import SwiftUI
import AVFoundation
import NessyAgentKit

/// NESSY DEVIATION (F5): the QR scanner behind the Scan button.
///
/// Typing a URL and a 32-character token by hand is the most error-prone step
/// this app has. The scanner replaces both, and — because the QR also carries
/// the certificate fingerprint — the manual comparison F1 introduced as well.
struct PairingScannerView: UIViewControllerRepresentable {
    let onScanned: (PairingPayload) -> Void
    let onFailed: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIViewController(context: Context) -> ScannerViewController {
        let controller = ScannerViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: ScannerViewController, context: Context) {}

    final class Coordinator: NSObject, ScannerViewControllerDelegate {
        private let parent: PairingScannerView
        /// One payload per presentation: the capture session keeps firing, and
        /// re-applying a pairing mid-connect would race with itself.
        private var handled = false

        init(_ parent: PairingScannerView) { self.parent = parent }

        func scanner(didRead value: String) {
            guard !handled else { return }
            guard let payload = PairingPayload(scanned: value) else {
                // A camera sees a lot of QR codes; a wrong one is not an error
                // worth tearing the sheet down for.
                return
            }
            handled = true
            parent.onScanned(payload)
        }

        func scannerDidFail(_ reason: String) {
            guard !handled else { return }
            handled = true
            parent.onFailed(reason)
        }
    }
}

protocol ScannerViewControllerDelegate: AnyObject {
    func scanner(didRead value: String)
    func scannerDidFail(_ reason: String)
}

final class ScannerViewController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    weak var delegate: ScannerViewControllerDelegate?
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "ph.princess.frog-2.nessy-desktop.scanner")
    private var previewLayer: AVCaptureVideoPreviewLayer?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else {
            // The simulator has no camera. Say so plainly rather than showing a
            // black rectangle that looks like a broken feature.
            delegate?.scannerDidFail(String(localized: "This device has no camera available for scanning."))
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            delegate?.scannerDidFail(String(localized: "This device has no camera available for scanning."))
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer

        // The capture session must not start on the main thread — but it is
        // also not Sendable, so it is handed to a serial queue rather than a
        // detached task.
        sessionQueue.async { [session] in session.startRunning() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [session] in session.stopRunning() }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = object.stringValue
        else { return }
        delegate?.scanner(didRead: value)
    }
}
