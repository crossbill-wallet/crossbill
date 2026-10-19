import Foundation
import Tor

/// Runs one embedded Tor client for the life of the app and hands out a URLSession that routes through it.
///
/// Tor can only be started once per process, so the thread is created at most once. The controller connection
/// is re-established if iOS dropped it while the app was suspended.
final class TorService {
    static let shared = TorService()

    /// A fixed local SOCKS port, so nothing has to be read back from Tor to know where it listens.
    static let socksPort: UInt = 39050

    private let queue = DispatchQueue(label: "shrike.tor")
    private var thread: TorThread?
    private var controller: TorController?
    private var configuration: TorConfiguration?
    private var authenticated = false

    private(set) var state = "off"
    private(set) var progress = 0
    private(set) var summary: String?
    private(set) var lastError: String?
    private(set) var session: URLSession?

    private init() {}

    func snapshot() -> [String: Any] {
        queue.sync {
            var out: [String: Any] = ["state": state, "progress": progress]
            if let summary = summary { out["summary"] = summary }
            if let lastError = lastError { out["error"] = lastError }
            return out
        }
    }

    func start() {
        queue.async { self.startOnQueue() }
    }

    private func startOnQueue() {
        if thread != nil {
            // Already running: make sure the controller is still attached, and clear an earlier error so the
            // status reads as starting while it reconnects
            if !authenticated || controller?.isConnected != true {
                if state == "error" {
                    state = "starting"
                    lastError = nil
                }
                connectController(attempt: 0)
            }
            return
        }

        state = "starting"
        progress = 0
        lastError = nil

        let fm = FileManager.default
        guard let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            fail("No place to keep Tor's data")
            return
        }
        var dataDir = support.appendingPathComponent("tor", isDirectory: true)
        try? fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dataDir.setResourceValues(values)
        // A stale control port file or cookie from an earlier launch would point the controller at a dead port,
        // or authenticate with the wrong secret before Tor writes the new one
        try? fm.removeItem(at: dataDir.appendingPathComponent("controlport"))
        try? fm.removeItem(at: dataDir.appendingPathComponent("control_auth_cookie"))

        let conf = TorConfiguration()
        conf.ignoreMissingTorrc = true
        conf.avoidDiskWrites = true
        conf.clientOnly = true
        conf.cookieAuthentication = true
        conf.autoControlPort = true
        conf.dataDirectory = dataDir
        conf.socksPort = TorService.socksPort
        configuration = conf

        let t = TorThread(configuration: conf)
        t.start()
        thread = t
        connectController(attempt: 0)
    }

    private func connectController(attempt: Int) {
        guard let conf = configuration, let portFile = conf.controlPortFile else {
            fail("Tor is not configured")
            return
        }
        // TorController asserts on a malformed file, so only hand it one Tor has finished writing: PORT=host:port
        let written = (try? String(contentsOf: portFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard written.hasPrefix("PORT="), written.contains(":"), let cookie = conf.cookie else {
            if attempt > 120 {
                fail("Tor did not start its control port")
                return
            }
            queue.asyncAfter(deadline: .now() + 0.25) { self.connectController(attempt: attempt + 1) }
            return
        }

        // The initializer already opens the socket when it can, and connect() on an open controller returns NO
        // without an error. So only call connect() when the initializer couldn't get through.
        let c = TorController(controlPortFile: portFile)
        if !c.isConnected {
            do {
                try c.connect()
            } catch {
                if attempt > 120 {
                    fail("Could not reach Tor's control port: \(error.localizedDescription)")
                } else {
                    queue.asyncAfter(deadline: .now() + 0.25) { self.connectController(attempt: attempt + 1) }
                }
                return
            }
        }
        controller = c
        c.authenticate(with: cookie) { success, error in
            self.queue.async {
                if success {
                    self.authenticated = true
                    if self.state != "ready" { self.state = "starting" }
                } else {
                    self.fail("Tor refused the control connection: \(error?.localizedDescription ?? "unknown error")")
                }
            }
        }
    }

    /// Reads bootstrap progress from Tor, and builds the session once Tor reports it is fully connected.
    func poll() {
        queue.async {
            guard self.authenticated, let c = self.controller else { return }
            if !c.isConnected {
                self.authenticated = false
                self.connectController(attempt: 0)
                return
            }
            // Swift keeps the Objective-C name here (getInfoForKeys:completion:), since "get" alone is too
            // vague a base name for the importer to split off "forKeys"
            c.getInfoForKeys(["status/bootstrap-phase"]) { values in
                guard let line = values.first else { return }
                let progress = TorService.field("PROGRESS", in: line).flatMap { Int($0) } ?? 0
                let summary = TorService.field("SUMMARY", in: line)
                self.queue.async {
                    self.progress = progress
                    self.summary = summary
                    if progress >= 100 && self.session == nil {
                        c.getSessionConfiguration { configuration in
                            guard let configuration = configuration else { return }
                            configuration.timeoutIntervalForResource = 6 * 60 * 60
                            configuration.waitsForConnectivity = false
                            let session = URLSession(configuration: configuration, delegate: OnionTrustDelegate(), delegateQueue: nil)
                            self.queue.async {
                                self.session = session
                                self.state = "ready"
                            }
                        }
                    }
                }
            }
        }
    }

    /// SIGNAL RELOAD and NEWNYM: reopens listeners iOS may have closed while the app was suspended, and moves
    /// to fresh circuits. Called after a request through Tor fails at the network level.
    func recover(completion: @escaping () -> Void) {
        queue.async {
            guard let c = self.controller, c.isConnected, self.authenticated else {
                if self.thread != nil { self.connectController(attempt: 0) }
                completion()
                return
            }
            c.resetConnection { _ in completion() }
        }
    }

    func readySession() -> URLSession? {
        queue.sync { state == "ready" ? session : nil }
    }

    /// After the app was suspended, re-attach the controller if iOS closed its socket.
    func foreground() {
        queue.async {
            guard self.thread != nil else { return }
            if self.controller?.isConnected != true {
                self.authenticated = false
                self.connectController(attempt: 0)
            }
        }
    }

    private func fail(_ message: String) {
        state = "error"
        lastError = message
    }

    /// Reads KEY=value or KEY="quoted value" from a Tor status line.
    static func field(_ key: String, in line: String) -> String? {
        guard let range = line.range(of: "\(key)=") else { return nil }
        let rest = line[range.upperBound...]
        if rest.hasPrefix("\"") {
            let body = rest.dropFirst()
            guard let end = body.firstIndex(of: "\"") else { return String(body) }
            return String(body[..<end])
        }
        return String(rest.prefix { !$0.isWhitespace })
    }
}

/// Accepts the TLS certificate of a .onion host reached through Tor, and leaves every other host to the normal
/// system check.
///
/// An onion address is the service's own public key, and Tor only completes the connection to whoever holds the
/// matching private key, so the certificate adds nothing there. StartOS serves RPC on its onion address over HTTPS
/// with a certificate from its own root CA, which iOS has never heard of, so the system check would refuse it.
final class OnionTrustDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        if space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           space.host.lowercased().hasSuffix(".onion"),
           let trust = space.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
}
