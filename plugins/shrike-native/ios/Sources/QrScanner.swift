import Foundation
import Capacitor
import UIKit
import VisionKit

/// Presents Apple's VisionKit scanner full screen and resolves the plugin call with the first QR code read,
/// or with null if the person cancels. Requires iOS 16, which the podspec requires anyway.
final class QrScanner: NSObject, DataScannerViewControllerDelegate {
    private var call: CAPPluginCall?
    private let onFinish: () -> Void
    private weak var navigation: UINavigationController?
    private weak var scannerController: DataScannerViewController?

    init(call: CAPPluginCall, onFinish: @escaping () -> Void) {
        self.call = call
        self.onFinish = onFinish
    }

    func present(from host: UIViewController) {
        guard DataScannerViewController.isSupported else {
            finish(error: "This iPhone can’t scan QR codes with the camera")
            return
        }
        guard DataScannerViewController.isAvailable else {
            finish(error: "The camera isn’t available. Check camera access for Shrike in Settings.")
            return
        }
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = self
        scanner.title = "Scan QR code"
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

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
        for item in addedItems {
            if case .barcode(let code) = item, let text = code.payloadStringValue {
                finish(value: text)
                return
            }
        }
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
        if case .barcode(let code) = item, let text = code.payloadStringValue {
            finish(value: text)
        }
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
