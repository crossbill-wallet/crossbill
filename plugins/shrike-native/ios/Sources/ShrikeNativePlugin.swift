import Foundation
import Capacitor
import LocalAuthentication
import Security
import UIKit
import AVFoundation

/// The app's one native plugin. Called from src/app/native.ts as ShrikeNative.
///
/// Keep the class annotation below the only explicit Objective-C name in the plugin's Swift files. Capacitor
/// registers plugin classes by searching the sources for that annotation, comments included.
@objc(ShrikeNativePlugin)
public class ShrikeNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ShrikeNativePlugin"
    public let jsName = "ShrikeNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "torStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "torStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "torRecover", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "httpRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vaultSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vaultGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vaultDelete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometryType", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanQr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copyPrivately", returnType: CAPPluginReturnPromise),
    ]

    private static let vaultService = "shrike.mobile.vault"
    private let plainSession = URLSession(configuration: .ephemeral)
    private var cover: UIView?
    private var scanner: AnyObject?

    public override func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(appWillResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appDidBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(userTookScreenshot), name: UIApplication.userDidTakeScreenshotNotification, object: nil)
    }

    // iOS can't stop a screenshot, only report one after the fact. Screens showing seed words listen for this
    @objc private func userTookScreenshot() {
        notifyListeners("screenshot", data: [:])
    }

    // MARK: Tor

    @objc func torStart(_ call: CAPPluginCall) {
        TorService.shared.start()
        call.resolve()
    }

    @objc func torStatus(_ call: CAPPluginCall) {
        TorService.shared.poll()
        call.resolve(TorService.shared.snapshot())
    }

    @objc func torRecover(_ call: CAPPluginCall) {
        TorService.shared.recover { call.resolve() }
    }

    // MARK: HTTP

    @objc func httpRequest(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("Bad node address")
            return
        }
        let useTor = call.getBool("useTor") ?? true
        let session: URLSession
        if useTor {
            guard let s = TorService.shared.readySession() else {
                call.reject("Tor is not connected yet")
                return
            }
            session = s
        } else {
            session = plainSession
        }

        var request = URLRequest(url: url)
        // POST for node RPC; GET for the public price data, which takes no body
        let method = call.getString("method") ?? "POST"
        request.httpMethod = method == "GET" ? "GET" : "POST"
        if request.httpMethod == "POST" {
            request.httpBody = (call.getString("body") ?? "").data(using: .utf8)
        }
        request.timeoutInterval = (call.getDouble("timeoutMs") ?? 90_000) / 1000
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let headers = call.getObject("headers") {
            for (name, value) in headers {
                if let v = value as? String { request.setValue(v, forHTTPHeaderField: name) }
            }
        }

        session.dataTask(with: request) { data, response, error in
            if let error = error {
                // Keep the codes: "A TLS error caused the secure connection to fail" alone doesn't say which part
                // of the handshake failed, and the stream code (-98xx) does
                let ns = error as NSError
                var codes = "\(ns.code)"
                if let stream = ns.userInfo["_kCFStreamErrorCodeKey"] as? Int { codes += ", \(stream)" }
                call.reject("\(ns.localizedDescription) (\(codes))")
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            call.resolve(["status": status, "body": body])
        }.resume()
    }

    // MARK: Keychain

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: ShrikeNativePlugin.vaultService,
            kSecAttrAccount as String: key,
        ]
    }

    @objc func vaultSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("Missing key or value")
            return
        }
        let requireAuth = call.getBool("requireAuth") ?? false
        DispatchQueue.global(qos: .userInitiated).async {
            let base = self.baseQuery(key)
            SecItemDelete(base as CFDictionary)
            var add = base
            add[kSecValueData as String] = Data(value.utf8)
            if requireAuth {
                // Bound to this device and its passcode; reading it asks for Face ID, Touch ID or the passcode
                var error: Unmanaged<CFError>?
                guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, &error) else {
                    call.reject("Could not set up Keychain protection")
                    return
                }
                add[kSecAttrAccessControl as String] = access
            } else {
                add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            }
            let status = SecItemAdd(add as CFDictionary, nil)
            if status == errSecSuccess {
                call.resolve()
            } else if requireAuth && (status == errSecNotAvailable || status == errSecAuthFailed || status == errSecParam) {
                call.reject("Set a passcode on this iPhone first. The seed words can only be stored behind one.")
            } else {
                call.reject("The Keychain refused to save this (error \(status))")
            }
        }
    }

    @objc func vaultGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing key")
            return
        }
        let prompt = call.getString("prompt") ?? "Confirm it’s you"
        DispatchQueue.global(qos: .userInitiated).async {
            let context = LAContext()
            context.localizedReason = prompt
            var query = self.baseQuery(key)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            query[kSecUseAuthenticationContext as String] = context
            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            switch status {
            case errSecSuccess:
                if let data = item as? Data, let value = String(data: data, encoding: .utf8) {
                    call.resolve(["value": value])
                } else {
                    call.reject("The stored value could not be read")
                }
            case errSecItemNotFound:
                call.resolve(["value": NSNull()])
            case errSecUserCanceled:
                call.reject("Cancelled")
            case errSecAuthFailed:
                call.reject("Face ID did not confirm it’s you")
            default:
                call.reject("The Keychain could not read this (error \(status))")
            }
        }
    }

    @objc func vaultDelete(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing key")
            return
        }
        SecItemDelete(baseQuery(key) as CFDictionary)
        call.resolve()
    }

    // MARK: Face ID

    @objc func authenticate(_ call: CAPPluginCall) {
        let reason = call.getString("reason") ?? "Open Shrike"
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // No passcode on the device, so there is nothing to check against
            call.resolve(["ok": true])
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
            call.resolve(["ok": ok])
        }
    }

    @objc func biometryType(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        let type: String
        switch context.biometryType {
        case .faceID: type = "faceId"
        case .touchID: type = "touchId"
        default: type = "none"
        }
        call.resolve(["type": type])
    }

    // MARK: QR scanning

    @objc func scanQr(_ call: CAPPluginCall) {
        let present = {
            DispatchQueue.main.async {
                guard let host = self.bridge?.viewController else {
                    call.reject("Nothing to present the scanner from")
                    return
                }
                let s = QrScanner(call: call) { [weak self] in self?.scanner = nil }
                self.scanner = s
                s.present(from: host)
            }
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            present()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                if granted { present() } else { call.reject("Camera access is off. Turn it on for Shrike in Settings to scan QR codes.") }
            }
        default:
            call.reject("Camera access is off. Turn it on for Shrike in Settings to scan QR codes.")
        }
    }

    // MARK: Links

    /// Opens a link outside the app: https in Safari, onionhttp(s) in Onion Browser. opened is false when no
    /// installed app takes the link, which for an onion link means Onion Browser isn't installed.
    @objc func openUrl(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let url = URL(string: s) else {
            call.reject("Bad link")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { ok in
                call.resolve(["opened": ok])
            }
        }
    }

    // MARK: Clipboard

    /// Copies a secret (a two-factor key, recovery codes) for this device only, so Universal Clipboard never
    /// hands it to a Mac or iPad, and has iOS clear it after a while.
    @objc func copyPrivately(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        let seconds = call.getDouble("seconds") ?? 60
        DispatchQueue.main.async {
            UIPasteboard.general.setItems(
                [["public.utf8-plain-text": text]],
                options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(seconds)]
            )
            call.resolve()
        }
    }

    // MARK: Privacy cover in the app switcher

    @objc private func appWillResignActive() {
        DispatchQueue.main.async {
            guard self.cover == nil, let window = self.bridge?.viewController?.view.window else { return }
            let v = UIView(frame: window.bounds)
            v.backgroundColor = .black
            v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            window.addSubview(v)
            self.cover = v
        }
    }

    @objc private func appDidBecomeActive() {
        DispatchQueue.main.async {
            self.cover?.removeFromSuperview()
            self.cover = nil
        }
        TorService.shared.foreground()
    }
}
