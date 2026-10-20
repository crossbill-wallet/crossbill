import Foundation
import CFNetwork
import Tor

/// Runs one embedded Tor client for the life of the app and hands out a URLSession that routes through it.
///
/// Tor can only be started once per process, so the thread is created at most once. Everything else is kept
/// repairable instead, because iOS takes back the networking resources of an app it has suspended
/// (Technote 2277, "Networking and Multitasking"):
///
/// - Tor's SOCKS port is a listening socket. After a while in the background iOS reclaims it, and from then on
///   connecting to it is refused (ECONNREFUSED), even after the app is back. Tor doesn't notice, and a reload
///   keeps the dead listener, so `repair` has Tor open a fresh one on the next port in `socksPorts` and builds a
///   new session for it.
/// - The control connection can die the same way. `repair` checks it with a command Tor has to answer, and
///   reattaches if it gets none. If Tor's control listener was taken back too, nothing in the app can reach Tor
///   again, and the page says to close and reopen the app.
///
/// Coming back from the background always moves the SOCKS listener to a fresh port, as Apple recommends for
/// listening sockets, so the port the session uses is one Tor opened just now.
///
/// Tor.framework hands each reply to the newest waiting command first, so `command` only accepts a reply that
/// fits the command it sent, and repairs run one at a time.
final class TorService {
    static let shared = TorService()

    /// Local SOCKS ports, used in turn. A fresh listener goes on a different port from the one iOS took back,
    /// since a port can read as busy for a while after it's closed.
    static let socksPorts: [UInt] = [39050, 39051, 39052, 39053]

    private let queue = DispatchQueue(label: "shrike.tor")
    private var thread: TorThread?
    private var controller: TorController?
    private var configuration: TorConfiguration?
    private var authenticated = false
    /// A reconnect loop is running, so another isn't started alongside it
    private var connecting = false
    /// The last reconnect loop gave up: Tor's control listener is gone
    private var attachFailed = false
    private var socksPort: UInt = TorService.socksPorts[0]
    /// Repairs asked for: what each wants, and its callback. The first one runs; the rest wait for it
    private var repairQueue: [(newCircuit: Bool, freshPort: Bool, done: ([String: Any]) -> Void)] = []
    /// The controller whose AUTHENTICATE hasn't been answered yet, so a second reattach isn't started over it
    private var authPendingFor: TorController?

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
        conf.socksPort = socksPort
        configuration = conf

        let t = TorThread(configuration: conf)
        t.start()
        thread = t
        connectController(attempt: 0)
    }

    private func connectController(attempt: Int) {
        if attempt == 0 {
            if connecting { return }
            if let pending = authPendingFor, pending === controller { return }
            connecting = true
            attachFailed = false
        }
        // Reattaching after the session was built, a refused control port won't come back by itself: iOS took
        // the listener while the app was suspended. So give up after a couple of seconds rather than thirty
        let limit = session == nil ? 120 : 8
        let giveUp: (String) -> Void = { message in
            self.connecting = false
            self.attachFailed = true
            self.fail(message)
        }
        guard let conf = configuration, let portFile = conf.controlPortFile else {
            giveUp("Tor is not configured")
            return
        }
        // TorController asserts on a malformed file, so only hand it one Tor has finished writing: PORT=host:port
        let written = (try? String(contentsOf: portFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard written.hasPrefix("PORT="), written.contains(":"), let cookie = conf.cookie else {
            if attempt > limit {
                giveUp("Tor did not start its control port")
                return
            }
            queue.asyncAfter(deadline: .now() + 0.25) { self.connectController(attempt: attempt + 1) }
            return
        }
        // Check the port takes connections before handing it to TorController, which leaks its socket when a
        // connect fails
        if let port = written.split(separator: ":").last.flatMap({ UInt($0) }), !TorService.listening(port: port) {
            if attempt > limit {
                giveUp("Could not reach Tor's control port")
            } else {
                queue.asyncAfter(deadline: .now() + 0.25) { self.connectController(attempt: attempt + 1) }
            }
            return
        }

        // The initializer already opens the socket when it can, and connect() on an open controller returns NO
        // without an error. So only call connect() when the initializer couldn't get through.
        let c = TorController(controlPortFile: portFile)
        if !c.isConnected {
            do {
                try c.connect()
            } catch {
                if attempt > limit {
                    giveUp("Could not reach Tor's control port: \(error.localizedDescription)")
                } else {
                    queue.asyncAfter(deadline: .now() + 0.25) { self.connectController(attempt: attempt + 1) }
                }
                return
            }
        }
        // Never call disconnect() on an old controller: Tor.framework's disconnect sends SIGNAL SHUTDOWN, which
        // would stop Tor for the rest of the process. A replaced controller is just let go.
        controller = c
        authenticated = false
        connecting = false
        authPendingFor = c
        // An AUTHENTICATE that's never answered mustn't block reattaching for good
        queue.asyncAfter(deadline: .now() + 10) {
            if self.authPendingFor === c {
                self.authPendingFor = nil
                self.attachFailed = true
            }
        }
        c.authenticate(with: cookie) { success, error in
            self.queue.async {
                if self.authPendingFor === c { self.authPendingFor = nil }
                // A controller replaced in the meantime doesn't count
                guard self.controller === c else { return }
                if success {
                    self.authenticated = true
                    self.lastError = nil
                    if self.state != "ready" { self.state = "starting" }
                } else {
                    self.attachFailed = true
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
                    if progress >= 100 && self.state != "ready" {
                        if self.session == nil { self.session = TorService.makeSession(port: self.socksPort) }
                        self.state = "ready"
                    }
                }
            }
        }
    }

    func readySession() -> URLSession? {
        queue.sync { state == "ready" ? session : nil }
    }

    // MARK: Checking and repairing

    /// What works right now: whether the controller answers, whether the SOCKS port takes connections, and
    /// whether Tor has a circuit ready.
    func check(done: @escaping ([String: Any]) -> Void) {
        queue.async {
            let running = self.thread != nil
            let socks = running && TorService.listening(port: self.socksPort)
            guard running, let c = self.controller, c.isConnected, self.authenticated else {
                done(["state": self.state, "controller": false, "socks": socks, "circuit": false, "port": Int(self.socksPort)])
                return
            }
            self.command(c, "GETINFO", ["status/circuit-established"], timeout: 3) { reply in
                let circuit = reply?.lines.contains(where: { $0.contains("circuit-established=1") }) ?? false
                done(["state": self.state, "controller": reply != nil, "socks": socks, "circuit": circuit, "port": Int(self.socksPort)])
            }
        }
    }

    /// Makes Tor usable again after iOS suspended the app. If the SOCKS port refuses connections (or `freshPort`),
    /// it has Tor open a new listener on another port; with `newCircuit`, it asks Tor for new circuits; and it
    /// reattaches the controller when either needs it. Reports `ok`, whether the port was `reopened`, and on
    /// failure the `stage`: "off" (Tor never started), "control" (no controller, and the port doesn't work) or
    /// "socks" (no port would open). One repair runs at a time; a call during one gets that one's result.
    func repair(newCircuit: Bool, freshPort: Bool = false, done: @escaping ([String: Any]) -> Void) {
        queue.async {
            guard self.thread != nil else {
                done(["ok": false, "stage": "off"])
                return
            }
            self.repairQueue.append((newCircuit, freshPort, done))
            if self.repairQueue.count == 1 { self.nextRepair() }
        }
    }

    /// Runs one repair covering everything the waiting callers asked for. A caller that joined while a repair
    /// was running, and wanted something it didn't do (a new circuit, a fresh port), gets another run.
    private func nextRepair() {
        guard let first = repairQueue.first else { return }
        let wantCircuit = first.newCircuit
        let wantPort = first.freshPort
        runRepair(newCircuit: wantCircuit, freshPort: wantPort) { result in
            let served = self.repairQueue.filter { (!$0.newCircuit || wantCircuit) && (!$0.freshPort || wantPort) }
            self.repairQueue = self.repairQueue.filter { ($0.newCircuit && !wantCircuit) || ($0.freshPort && !wantPort) }
            for w in served { w.done(result) }
            if !self.repairQueue.isEmpty {
                let merged = (self.repairQueue.contains { $0.newCircuit }, self.repairQueue.contains { $0.freshPort })
                let rest = self.repairQueue
                self.repairQueue = [(newCircuit: merged.0, freshPort: merged.1, done: { r in for w in rest { w.done(r) } })]
                self.nextRepair()
            }
        }
    }

    private func runRepair(newCircuit: Bool, freshPort: Bool, finish: @escaping ([String: Any]) -> Void) {
        let socksOK = TorService.listening(port: socksPort)
        let fine: (Bool) -> [String: Any] = { reopened in ["ok": true, "reopened": reopened, "port": Int(self.socksPort)] }
        if socksOK && !newCircuit && !freshPort {
            // The port works, so nothing waits on the controller. Reattach it in the background if it's gone
            if !(authenticated && controller?.isConnected == true) { connectController(attempt: 0) }
            finish(fine(false))
            return
        }
        ensureController(timeout: 12) { found in
            guard let c = found else {
                // Without a controller nothing can be moved or renewed, but a port that works still works
                finish(TorService.listening(port: self.socksPort) ? fine(false) : ["ok": false, "stage": "control"])
                return
            }
            let renew: (Bool) -> Void = { reopened in
                if newCircuit {
                    self.command(c, "SIGNAL", ["NEWNYM"], timeout: 4) { _ in finish(fine(reopened)) }
                } else {
                    finish(fine(reopened))
                }
            }
            if socksOK && !freshPort {
                renew(false)
                return
            }
            let others = TorService.socksPorts.filter { $0 != self.socksPort }
            self.reopenSocks(c, candidates: others + [self.socksPort]) { opened in
                if opened {
                    if self.progress >= 100 { self.state = "ready" }
                    renew(true)
                } else {
                    // A failed move can still have closed the old listener, so look again rather than trust the first probe
                    finish(TorService.listening(port: self.socksPort) ? fine(false) : ["ok": false, "stage": "socks"])
                }
            }
        }
    }

    /// Called when the app comes back from the background: moves the SOCKS listener to a fresh port.
    func foreground() {
        queue.async {
            guard self.thread != nil else { return }
            self.repair(newCircuit: false, freshPort: true) { _ in }
        }
    }

    /// The older name for a repair with new circuits.
    func recover(completion: @escaping () -> Void) {
        repair(newCircuit: true) { _ in completion() }
    }

    /// The controller, checked with a command Tor has to answer. A connection iOS has taken back can look open
    /// until something is sent on it, so one that stays silent is dropped and a new one made.
    private func ensureController(timeout: Double, done: @escaping (TorController?) -> Void) {
        if let c = controller, c.isConnected, authenticated {
            command(c, "GETINFO", ["version"], timeout: 3) { reply in
                if reply != nil {
                    done(c)
                } else {
                    // Let it go without disconnect(), which would shut Tor down
                    self.controller = nil
                    self.authenticated = false
                    self.connectController(attempt: 0)
                    self.waitForController(until: .now() + timeout, done: done)
                }
            }
        } else {
            // A controller still waiting on AUTHENTICATE is left to finish rather than replaced
            if authPendingFor == nil || authPendingFor !== controller { authenticated = false }
            connectController(attempt: 0)
            waitForController(until: .now() + timeout, done: done)
        }
    }

    private func waitForController(until deadline: DispatchTime, done: @escaping (TorController?) -> Void) {
        if authenticated, let c = controller, c.isConnected {
            done(c)
        } else if attachFailed || DispatchTime.now() >= deadline {
            done(nil)
        } else {
            queue.asyncAfter(deadline: .now() + 0.25) { self.waitForController(until: deadline, done: done) }
        }
    }

    /// Moves Tor's SOCKS listener to the first of `candidates` that opens, and builds a session for it.
    private func reopenSocks(_ c: TorController, candidates: [UInt], done: @escaping (Bool) -> Void) {
        guard let port = candidates.first else {
            done(false)
            return
        }
        // Whatever SETCONF's reply says, Tor's own list of listeners is what counts: it can't be mistaken for
        // another command's reply, and it shows a change that landed after a timeout
        command(c, "SETCONF", ["SocksPort=\(port)"], timeout: 5) { _ in
            self.command(c, "GETINFO", ["net/listeners/socks"], timeout: 4) { reply in
                let ports = reply?.lines.first.map(TorService.ports(in:)) ?? []
                guard ports.contains(port) && TorService.listening(port: port) else {
                    self.reopenSocks(c, candidates: Array(candidates.dropFirst()), done: done)
                    return
                }
                self.socksPort = port
                // Retired later rather than now: a request may have just taken the old session from
                // readySession(), and starting a task on an invalidated session throws
                if let old = self.session {
                    self.queue.asyncAfter(deadline: .now() + 120) { old.finishTasksAndInvalidate() }
                }
                self.session = TorService.makeSession(port: port)
                done(true)
            }
        }
    }

    /// The port numbers in a net/listeners/socks value, such as "127.0.0.1:39051" "[::1]:39051".
    static func ports(in line: String) -> [UInt] {
        guard let eq = line.firstIndex(of: "=") else { return [] }
        return line[line.index(after: eq)...]
            .split(separator: " ")
            .compactMap { entry in
                let trimmed = entry.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
                return trimmed.split(separator: ":").last.flatMap { UInt($0) }
            }
    }

    private struct Reply {
        let code: Int
        let lines: [String]
    }

    /// Sends one control command and calls back on the service queue with Tor's reply, or with nil if the
    /// controller isn't connected or Tor doesn't answer within `timeout` seconds.
    ///
    /// Tor.framework offers each reply to the newest waiting observer first, and other commands (the bootstrap
    /// poll, for one) run alongside these. So the observer only takes a reply that fits: for GETINFO, one that
    /// starts with the key asked for; for anything else, a one-line reply. Anything else is passed on.
    private func command(_ c: TorController, _ name: String, _ arguments: [String], timeout: Double, done: @escaping (Reply?) -> Void) {
        let lock = NSLock()
        var finished = false
        let finish: (Reply?) -> Void = { reply in
            lock.lock()
            let first = !finished
            finished = true
            lock.unlock()
            if first { self.queue.async { done(reply) } }
        }
        guard c.isConnected else {
            finish(nil)
            return
        }
        let key = name == "GETINFO" ? arguments.first.map { "\($0)=" } : nil
        queue.asyncAfter(deadline: .now() + timeout) { finish(nil) }
        c.sendCommand(name, arguments: arguments, data: nil) { codes, lines, stop in
            let text = lines.compactMap { String(data: $0, encoding: .utf8) }
            if let key = key {
                guard text.first?.hasPrefix(key) == true else { return false }
            } else {
                guard codes.count == 1 else { return false }
            }
            stop.pointee = true
            finish(Reply(code: codes.first?.intValue ?? 0, lines: text))
            return true
        }
    }

    /// Whether something accepts connections on a local port right now. A port iOS took back refuses.
    static func listening(port: UInt) -> Bool {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 { return false }
        defer { Darwin.close(fd) }
        var on: Int32 = 1
        _ = Darwin.setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        let flags = Darwin.fcntl(fd, F_GETFL, 0)
        _ = Darwin.fcntl(fd, F_SETFL, flags | O_NONBLOCK)

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port)).bigEndian
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if result == 0 { return true }
        if errno != EINPROGRESS { return false }

        var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        if Darwin.poll(&pfd, 1, 1000) <= 0 { return false }
        var err: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        _ = Darwin.getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len)
        return err == 0
    }

    /// A session that sends everything through Tor's SOCKS port. The same proxy settings Tor.framework's
    /// getSessionConfiguration builds, including "localhost" rather than 127.0.0.1: with the IP, real devices
    /// fail to resolve .onion names through the proxy.
    static func makeSession(port: UInt) -> URLSession {
        let configuration = URLSessionConfiguration.default
        configuration.connectionProxyDictionary = [
            kCFProxyTypeKey as String: kCFProxyTypeSOCKS as String,
            kCFStreamPropertySOCKSProxyHost as String: "localhost",
            kCFStreamPropertySOCKSProxyPort as String: NSNumber(value: port),
        ]
        configuration.timeoutIntervalForResource = 6 * 60 * 60
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration, delegate: OnionTrustDelegate(), delegateQueue: nil)
    }

    /// Records what went wrong. Once the session exists, a controller problem doesn't stop the SOCKS port from
    /// working, so the state stays as it is and only the error is kept.
    private func fail(_ message: String) {
        lastError = message
        if session == nil || progress < 100 { state = "error" }
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
