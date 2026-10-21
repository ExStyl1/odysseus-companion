import Foundation

/// NESSY DEVIATION (F1): the `URLSession` delegate that implements the
/// fingerprint trust model.
///
/// It is a separate object rather than a method on `RPCTransport` because the
/// transport is an `actor` and `URLSession` calls its delegate from an
/// arbitrary thread with a completion handler that must be invoked
/// synchronously-ish — hopping into an actor to answer a TLS challenge is both
/// awkward and easy to get wrong. The state here is tiny (one fingerprint) and
/// guarded by a lock.
public final class CertificatePinningDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var pinned: CertificateFingerprint?
    private var presented: CertificateFingerprint?

    /// The fingerprint the user confirmed. `nil` while pairing.
    public func setPinned(_ fingerprint: CertificateFingerprint?) {
        lock.lock(); defer { lock.unlock() }
        pinned = fingerprint
    }

    /// The fingerprint the server presented on the last handshake — what the
    /// pairing screen shows so the user can compare it with the server's.
    public func lastPresented() -> CertificateFingerprint? {
        lock.lock(); defer { lock.unlock() }
        return presented
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        guard let leaf = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let certificate = leaf.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let fingerprint = CertificateFingerprint(derBytes: SecCertificateCopyData(certificate) as Data)

        lock.lock()
        presented = fingerprint
        let expected = pinned
        lock.unlock()

        // A chain that validates on its own needs no pinning — a real
        // certificate must not be made harder to use than a self-signed one.
        var trusted = false
        if #available(iOS 12.0, *) {
            trusted = SecTrustEvaluateWithError(trust, nil)
        }

        switch certificateTrustDecision(presented: fingerprint, pinned: expected, systemTrusted: trusted) {
        case .systemTrusted, .pinned:
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .unknown:
            // Pairing: the caller reads `lastPresented()` and asks the user.
            // Accepting here is what makes the fingerprint READABLE before the
            // user answers; nothing is stored until they confirm, and the
            // connection is torn down if they decline.
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .changed:
            // Pinned and different. On a shared network this is what an
            // interposer looks like, so refuse rather than ask — a prompt here
            // trains the user to click through the one case that matters.
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
