import Foundation
import Capacitor
import UIKit
import VisionKit

/// Presents Apple's VisionKit scanner full screen. In the usual mode it resolves the plugin call with the first
/// QR code read, or with null if the person cancels. Requires iOS 16, which the podspec requires anyway.
///
/// In parts mode, for the animated codes a hardware wallet shows, it keeps scanning: each new code read is
/// handed to `onPart`, the app says how far along it is with `progress(_:)`, and `finishParts()` closes the
/// scanner and resolves the call with "finished". Cancelling resolves it with null, as in the usual mode.
final class QrScanner: NSObject, DataScannerViewControllerDelegate {
    private var call: CAPPluginCall?
    private let onFinish: () -> Void
    private let parts: Bool
    private let heading: String
    private let onPart: (String) -> Void
    private var seen = Set<String>()
    private weak var navigation: UINavigationController?
    private weak var scannerController: DataScannerViewController?

    init(call: CAPPluginCall, parts: Bool = false, title: String? = nil, onPart: @escaping (String) -> Void = { _ in }, onFinish: @escaping () -> Void) {
        self.call = call
        self.parts = parts
        self.heading = title ?? "Scan QR code"
        self.onPart = onPart
        self.onFinish = onFinish
    }

    func present(from host: UIViewController) {
        guard DataScannerViewController.isSupported else {
            finish(error: "This iPhone can’t scan QR codes with the camera")
            return
        }
        guard DataScannerViewController.isAvailable else {
            finish(error: "The camera isn’t available. Check camera access for Crossbill in Settings.")
            return
        }
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: parts,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = self
        scanner.title = heading
        scanner.navigationItem.leftBarButtonItem = UIBarButtonItem(
            systemItem: .cancel,
            primaryAction: UIAction { [weak self] _ in self?.finish(value: nil) }
        )
        let nav = UINavigationController(rootViewController: scanner)
        nav.modalPresentationStyle = .fullScreen
        navigation = nav
        scannerController = scanner
        host.present(nav, animated: true) {
            do {
                try scanner.startScanning()
            } catch {
                self.finish(error: "The camera could not start: \(error.localizedDescription)")
            }
        }
    }

    /// Shows how far along a series of codes is, under the title. `reset` forgets the codes already passed on,
    /// so they're passed on again when the app starts the series over.
    func progress(_ text: String, reset: Bool) {
        if reset { seen.removeAll() }
        scannerController?.navigationItem.prompt = text.isEmpty ? nil : text
    }

    func finishParts() {
        finish(value: "finished")
    }

    private func read(_ items: [RecognizedItem]) {
        for item in items {
            guard case .barcode(let code) = item, let text = code.payloadStringValue else { continue }
            if !parts {
                finish(value: text)
                return
            }
            // An animated code changes in place, so a new code can arrive as an update to the one on screen
            if seen.insert(text).inserted { onPart(text) }
        }
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        read(addedItems)
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didUpdate updatedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        if parts { read(updatedItems) }
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
        read([item])
    }

    private func finish(value: String?) {
        guard let call = call else { return }
        self.call = nil
        scannerController?.stopScanning()
        let done = {
            if let value = value {
                call.resolve(["value": value])
            } else {
                call.resolve(["value": NSNull()])
            }
            self.onFinish()
        }
        if let nav = navigation {
            nav.dismiss(animated: true, completion: done)
        } else {
            done()
        }
    }

    private func finish(error message: String) {
        guard let call = call else { return }
        self.call = nil
        let done = {
            call.reject(message)
            self.onFinish()
        }
        if let nav = navigation, nav.presentingViewController != nil {
            nav.dismiss(animated: true, completion: done)
        } else {
            done()
        }
    }
}
