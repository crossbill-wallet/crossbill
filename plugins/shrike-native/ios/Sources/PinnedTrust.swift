import Foundation
import Security
import CryptoKit
import Network

/// HTTPS to a server on the home network whose certificate comes from its own root CA, such as a StartOS server:
/// the server's chain must end in the one root this phone pinned, and nothing else is trusted for it.
///
/// Two ways in:
/// - `anchorDER`: the pinned root. The chain must evaluate to it alone, under the basic X.509 checks. The host
///   name isn't checked against the certificate, since the phone only ever asks the node's own addresses, and a
///   certificate can't name an address the server doesn't know (an IP, a name it was opened at).
/// - `captureSha256`: pairing. The last certificate the server presents is accepted as the root only if its
///   SHA-256 is the one the pairing code carries, and is kept in `capturedPEM` for the page to pin from then on.
///
/// Redirects are never followed: the phone's key goes to the node's own address and no other.
final class PinnedTrustDelegate: NSObject, URLSessionTaskDelegate {
    private let anchorDER: Data?
    private let captureSha256: String?
    private(set) var capturedPEM: String?
    private(set) var certificateFailed = false

    init(anchorDER: Data?, captureSha256: String?) {
        self.anchorDER = anchorDER
        self.captureSha256 = captureSha256?.uppercased()
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = space.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        // What the server presented, before anything is evaluated: its own certificate first, its root last
        let presented = (SecTrustCopyCertificateChain(trust) as? [SecCertificate]) ?? []
        var anchor: SecCertificate?
        if let der = anchorDER {
            anchor = SecCertificateCreateWithData(nil, der as CFData)
        } else if let want = captureSha256, let last = presented.last, PinnedTrustDelegate.fingerprint(last) == want {
            anchor = last
        }
        guard let root = anchor else {
            certificateFailed = true
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        SecTrustSetPolicies(trust, SecPolicyCreateBasicX509())
        SecTrustSetAnchorCertificates(trust, [root] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        var error: CFError?
        if SecTrustEvaluateWithError(trust, &error) {
            if anchorDER == nil { capturedPEM = PinnedTrustDelegate.pem(root) }
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            certificateFailed = true
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    /// SHA-256 of the certificate's DER, colon hex in capitals, as `openssl x509 -fingerprint -sha256` prints it.
    static func fingerprint(_ cert: SecCertificate) -> String {
        let der = SecCertificateCopyData(cert) as Data
        return SHA256.hash(data: der).map { String(format: "%02X", $0) }.joined(separator: ":")
    }

    static func pem(_ cert: SecCertificate) -> String {
        let b64 = (SecCertificateCopyData(cert) as Data).base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
        return "-----BEGIN CERTIFICATE-----\n\(b64)\n-----END CERTIFICATE-----\n"
    }

    /// The DER inside a PEM's first certificate, or nil.
    static func der(fromPEM pem: String) -> Data? {
        guard let start = pem.range(of: "-----BEGIN CERTIFICATE-----"),
              let end = pem.range(of: "-----END CERTIFICATE-----", range: start.upperBound..<pem.endIndex) else { return nil }
        let body = pem[start.upperBound..<end.lowerBound].components(separatedBy: .whitespacesAndNewlines).joined()
        return Data(base64Encoded: body)
    }
}

/// Refuses redirects for one request, on a session whose own delegate would follow them.
final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Whether the phone is on Wi-Fi right now, for choosing between a node's home addresses and its onion.
final class NetworkWatch {
    static let shared = NetworkWatch()
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "crossbill.network")
    private var path: NWPath?

    private init() {
        monitor.pathUpdateHandler = { [weak self] p in self?.path = p }
        monitor.start(queue: queue)
    }

    func snapshot() -> [String: Any] {
        let p = queue.sync { path }
        guard let p = p else { return ["known": false, "wifi": false, "cellular": false, "wired": false, "other": false] }
        return [
            "known": true,
            "satisfied": p.status == .satisfied,
            "wifi": p.usesInterfaceType(.wifi),
            "wired": p.usesInterfaceType(.wiredEthernet),
            "cellular": p.usesInterfaceType(.cellular),
            // A VPN, such as WireGuard to a home network, shows as "other"
            "other": p.usesInterfaceType(.other),
        ]
    }
}
