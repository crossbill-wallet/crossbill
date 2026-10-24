import Foundation
import Capacitor
import LocalAuthentication
import Security
import UIKit
import AVFoundation
import WidgetKit

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
        CAPPluginMethod(name: "torCheck", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "torRepair", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "httpRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vaultSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vaultGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vaultDelete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometryType", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanQr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanQrProgress", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanQrFinish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "keepAwake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copyPrivately", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "biometryTrust", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "widgetsUpdate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "widgetsInstalled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "networkPath", returnType: CAPPluginReturnPromise),
    ]

    private static let vaultService = "shrike.mobile.vault"
    private let plainSession = URLSession(configuration: .ephemeral)
    private var cover: UIView?
    private var scanner: QrScanner?

    public override func load() {
        // Starts watching the network now, so the first Lightning request already knows Wi-Fi from cellular
        _ = NetworkWatch.shared
        NotificationCenter.default.addObserver(self, selector: #selector(appWillResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appDidBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appWillEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
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

    /// Whether Tor's controller answers, its SOCKS port takes connections, and it has a circuit.
    @objc func torCheck(_ call: CAPPluginCall) {
        TorService.shared.check { call.resolve($0) }
    }

    /// Reattaches the controller and reopens the SOCKS port if iOS took them back while the app was suspended.
    @objc func torRepair(_ call: CAPPluginCall) {
        let newCircuit = call.getBool("newCircuit") ?? false
        let freshPort = call.getBool("freshPort") ?? false
        TorService.shared.repair(newCircuit: newCircuit, freshPort: freshPort) { call.resolve($0) }
    }

    // MARK: HTTP

    @objc func httpRequest(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("Bad node address")
            return
        }
        let useTor = call.getBool("useTor") ?? true
        // A Lightning Fork node at home: HTTPS whose chain must end in the root this phone pinned (pinPem), or,
        // while pairing, in the root whose SHA-256 the pairing code carries (captureRootSha256)
        let pinPem = call.getString("pinPem")
        let captureRoot = call.getString("captureRootSha256")
        let noRedirect = call.getBool("noRedirect") ?? false
        let session: URLSession
        var pinned: PinnedTrustDelegate?
        if useTor {
            guard let s = TorService.shared.readySession() else {
                call.reject("Tor is not connected yet")
                return
            }
            session = s
        } else if pinPem != nil || captureRoot != nil {
            var anchor: Data?
            if let pem = pinPem {
                guard let der = PinnedTrustDelegate.der(fromPEM: pem) else {
                    call.reject("The saved certificate for this node can't be read", "certificate")
                    return
                }
                anchor = der
            }
            let delegate = PinnedTrustDelegate(anchorDER: anchor, captureSha256: captureRoot)
            pinned = delegate
            let config = URLSessionConfiguration.ephemeral
            config.waitsForConnectivity = false
            session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
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

        let task = session.dataTask(with: request) { data, response, error in
            if pinned != nil { session.finishTasksAndInvalidate() }
            if let error = error {
                if pinned?.certificateFailed == true {
                    call.reject("This node's certificate isn't the one this phone paired with", "certificate")
                    return
                }
                // Keep the codes: "A TLS error caused the secure connection to fail" alone doesn't say which part
                // of the handshake failed, and the stream code (-98xx) does
                let ns = error as NSError
                let streamCode = ns.userInfo["_kCFStreamErrorCodeKey"] as? Int
                let streamDomain = ns.userInfo["_kCFStreamErrorDomainKey"] as? Int
                var codes = "\(ns.code)"
                if let stream = streamCode { codes += ", \(stream)" }
                call.reject("\(ns.localizedDescription) (\(codes))", ShrikeNativePlugin.errorKind(ns, streamDomain: streamDomain, streamCode: streamCode))
                return
            }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            var result: [String: Any] = ["status": status, "body": body]
            if let root = pinned?.capturedPEM { result["rootPem"] = root }
            call.resolve(result)
        }
        // The pinned session refuses redirects itself; over Tor the session's own delegate stays in charge of the
        // onion's certificate, and this one only stops a redirect
        if noRedirect && pinned == nil { task.delegate = NoRedirectDelegate() }
        task.resume()
    }

    /// Wi-Fi, cellular or a VPN, for choosing between a node's home address and its onion.
    @objc func networkPath(_ call: CAPPluginCall) {
        call.resolve(NetworkWatch.shared.snapshot())
    }

    /// A short name for what went wrong, passed to the page as the error's code. "refused" means the connection
    /// to the proxy on this phone was refused (POSIX domain, ECONNREFUSED), so the request never left the phone.
    static func errorKind(_ ns: NSError, streamDomain: Int?, streamCode: Int?) -> String {
        guard ns.domain == NSURLErrorDomain else { return "network" }
        switch ns.code {
        case NSURLErrorTimedOut:
            return "timeout"
        case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorDataNotAllowed:
            return "offline"
        case NSURLErrorCannotConnectToHost where streamDomain == 1 && streamCode == Int(ECONNREFUSED):
            return "refused"
        default:
            return "network"
        }
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
        // Readable without a prompt, but only while the iPhone has a passcode: removing it deletes the item
        let whenPasscodeSet = call.getBool("whenPasscodeSet") ?? false
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
                add[kSecAttrAccessible as String] = whenPasscodeSet ? kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly : kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            }
            let status = SecItemAdd(add as CFDictionary, nil)
            if status == errSecSuccess {
                call.resolve()
            } else if requireAuth && (status == errSecNotAvailable || status == errSecAuthFailed || status == errSecParam) {
                call.reject("Set a passcode on this iPhone first. The seed words can only be stored behind one.")
            } else if whenPasscodeSet && (status == errSecNotAvailable || status == errSecAuthFailed || status == errSecParam || status == errSecDecode) {
                call.reject("Set a passcode on this iPhone first. Lightning needs one.", "no-passcode")
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
        let biometricsOnly = call.getBool("biometricsOnly") ?? false
        let fallbackTitle = call.getString("fallbackTitle") ?? "Use PIN"
        DispatchQueue.global(qos: .userInitiated).async {
            let context = LAContext()
            context.localizedReason = prompt
            guard biometricsOnly else {
                self.readItem(key, context: context, call: call)
                return
            }
            // With the app PIN on: Face ID alone, with "Use PIN" in place of the iPhone passcode. If Face ID can't
            // confirm it's you, the page asks for the app PIN and then reads the item the usual way. On success the
            // same context goes to the Keychain, so it doesn't ask again.
            context.localizedFallbackTitle = fallbackTitle
            var error: NSError?
            guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
                call.reject("Face ID isn’t available", "needs-pin")
                return
            }
            guard !self.biometryChanged(context) else {
                call.reject("Face ID on this iPhone changed since the app PIN was set", "needs-pin")
                return
            }
            context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: prompt) { ok, _ in
                guard ok else {
                    call.reject("Face ID didn’t confirm it’s you", "needs-pin")
                    return
                }
                DispatchQueue.global(qos: .userInitiated).async {
                    self.readItem(key, context: context, call: call)
                }
            }
        }
    }

    private func readItem(_ key: String, context: LAContext, call: CAPPluginCall) {
        var query = baseQuery(key)
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
        let reason = call.getString("reason") ?? "Open Crossbill"
        let context = LAContext()
        var error: NSError?
        if call.getBool("biometricsOnly") ?? false {
            // With the app PIN on: Face ID alone. "Use PIN", a cancel or a failure all send the page to its PIN pad
            context.localizedFallbackTitle = call.getString("fallbackTitle") ?? "Use PIN"
            guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
                call.resolve(["ok": false, "pin": true])
                return
            }
            // A face added since the PIN was set (iOS lets anyone with the passcode add one) doesn't count
            guard !biometryChanged(context) else {
                call.resolve(["ok": false, "pin": true, "changed": true])
                return
            }
            context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, _ in
                call.resolve(["ok": ok, "pin": !ok])
            }
            return
        }
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            // No passcode on the device, so there is nothing to check against. Where something must be checked
            // (a Lightning payment, which reads no seed words), that's a refusal
            if call.getBool("requirePasscode") ?? false {
                call.resolve(["ok": false, "noPasscode": true])
            } else {
                call.resolve(["ok": true])
            }
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
            call.resolve(["ok": ok])
        }
    }

    // MARK: Face ID enrollment, while the app PIN is on

    private static let biometryStateKey = "biometry-state"

    /// The Face ID enrollment trusted when the app PIN was set, or last confirmed with the PIN. nil if none.
    private func trustedBiometryState() -> Data? {
        var query = baseQuery(Self.biometryStateKey)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess ? item as? Data : nil
    }

    /// Whether the faces Face ID accepts have changed since they were trusted. iOS changes this value when a face or
    /// an alternate appearance is added or removed. With nothing trusted, it counts as changed: fail closed.
    /// `context` must have been through canEvaluatePolicy for biometrics.
    private func biometryChanged(_ context: LAContext) -> Bool {
        guard let current = context.evaluatedPolicyDomainState, let trusted = trustedBiometryState() else { return true }
        return current != trusted
    }

    /// set: trust the faces Face ID accepts now. clear: forget them. check: whether they've changed.
    @objc func biometryTrust(_ call: CAPPluginCall) {
        let action = call.getString("action") ?? "check"
        DispatchQueue.global(qos: .userInitiated).async {
            let context = LAContext()
            var error: NSError?
            let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
            let base = self.baseQuery(Self.biometryStateKey)
            switch action {
            case "set":
                SecItemDelete(base as CFDictionary)
                if available, let state = context.evaluatedPolicyDomainState {
                    var add = base
                    add[kSecValueData as String] = state
                    add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
                    SecItemAdd(add as CFDictionary, nil)
                }
                call.resolve(["changed": false])
            case "clear":
                SecItemDelete(base as CFDictionary)
                call.resolve(["changed": false])
            default:
                call.resolve(["changed": available ? self.biometryChanged(context) : false])
            }
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
                if self.scanner != nil {
                    call.reject("The scanner is already open")
                    return
                }
                let parts = call.getBool("parts") ?? false
                let s = QrScanner(
                    call: call,
                    parts: parts,
                    title: call.getString("title"),
                    onPart: { [weak self] text in self?.notifyListeners("qrPart", data: ["value": text]) },
                    onFinish: { [weak self] in self?.scanner = nil }
                )
                self.scanner = s
                s.present(from: host)
            }
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            present()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                if granted { present() } else { call.reject("Camera access is off. Turn it on for Crossbill in Settings to scan QR codes.") }
            }
        default:
            call.reject("Camera access is off. Turn it on for Crossbill in Settings to scan QR codes.")
        }
    }

    /// For a scanner opened with parts: true. Shows the app's progress text under the title; reset makes the
    /// scanner pass on codes it has already passed on, for when the app starts a series over.
    @objc func scanQrProgress(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        let reset = call.getBool("reset") ?? false
        DispatchQueue.main.async {
            self.scanner?.progress(text, reset: reset)
            call.resolve()
        }
    }

    /// Closes a scanner opened with parts: true once the app has every code it needs.
    @objc func scanQrFinish(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.scanner?.finishParts()
            call.resolve()
        }
    }

    // MARK: Screen

    /// Keeps the screen from dimming and locking while on, as while a hardware wallet reads codes off it.
    @objc func keepAwake(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
            call.resolve()
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

    // MARK: Widgets

    /// Where the widgets read what the app hands them: a file in the App Group the app shares with its widget
    /// extension, named "group." and the app's bundle ID (ios/App/ShrikeWidgets/Snapshot.swift reads the same
    /// path). nil when this build has no such App Group, which iOS reports by giving no container.
    private static func widgetFile() -> URL? {
        guard let id = Bundle.main.bundleIdentifier,
              let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.\(id)") else { return nil }
        return dir.appendingPathComponent("Library/Application Support/Widgets", isDirectory: true)
            .appendingPathComponent("snapshot.json", isDirectory: false)
    }

    /// Saves what the widgets show and asks iOS to redraw them. The folder is kept out of iCloud backups, like
    /// the app's own data, and the file can be read once the iPhone has been unlocked after a restart, so the
    /// Lock Screen widgets can show it.
    @objc func widgetsUpdate(_ call: CAPPluginCall) {
        guard let file = Self.widgetFile() else {
            call.resolve(["ok": false, "reason": "no-app-group"])
            return
        }
        let fm = FileManager.default
        do {
            if let text = call.getString("snapshot") {
                var folder = file.deletingLastPathComponent()
                try fm.createDirectory(at: folder, withIntermediateDirectories: true)
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try folder.setResourceValues(values)
                try Data(text.utf8).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            } else if fm.fileExists(atPath: file.path) {
                try fm.removeItem(at: file)
            }
        } catch {
            call.reject("Couldn't save what the widgets show: \(error.localizedDescription)")
            return
        }
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve(["ok": true])
    }

    /// The Crossbill widgets on the Home Screen and Lock Screen, by kind and size.
    @objc func widgetsInstalled(_ call: CAPPluginCall) {
        let shared = Self.widgetFile() != nil
        WidgetCenter.shared.getCurrentConfigurations { found in
            var list: [[String: String]] = []
            if case .success(let infos) = found {
                list = infos.map { ["kind": $0.kind, "family": ShrikeNativePlugin.familyName($0.family)] }
            }
            var answer: [String: Any] = ["ok": shared, "widgets": list]
            if !shared { answer["reason"] = "no-app-group" }
            call.resolve(answer)
        }
    }

    private static func familyName(_ family: WidgetFamily) -> String {
        switch family {
        case .systemSmall: return "systemSmall"
        case .systemMedium: return "systemMedium"
        case .systemLarge: return "systemLarge"
        case .systemExtraLarge: return "systemExtraLarge"
        case .accessoryCircular: return "accessoryCircular"
        case .accessoryRectangular: return "accessoryRectangular"
        case .accessoryInline: return "accessoryInline"
        @unknown default: return "other"
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
    }

    // Only on a real return from the background, not after a Face ID prompt, which also makes the app inactive
    @objc private func appWillEnterForeground() {
        TorService.shared.foreground()
    }
}
