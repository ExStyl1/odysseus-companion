import Foundation
import CryptoKit

/// NESSY DEVIATION (F1): trust for a self-signed server certificate.
///
/// The server generates its own certificate, so there is no chain to validate
/// and `URLSession` will reject it. The trust decision therefore belongs to the
/// human: the server prints the certificate's SHA-256 fingerprint, this type
/// computes the fingerprint of whatever certificate was actually presented, and
/// the user confirms the two match before the connection is kept.
///
/// This is SSH's host-key model. Its one hard rule is that the confirmation
/// must be a real comparison — silently accepting any certificate would leave
/// the wire encrypted against eavesdroppers and wide open to anyone able to
/// answer on that address, which is precisely the attacker a shared network
/// has.
public struct CertificateFingerprint: Equatable, Hashable, Codable, Sendable {
    /// Uppercase, colon-separated SHA-256 over the DER bytes — the same shape
    /// `openssl x509 -fingerprint -sha256` and the server both print.
    public let value: String

    public init(value: String) {
        self.value = value
    }

    public init(derBytes: Data) {
        let digest = SHA256.hash(data: derBytes)
        self.value = digest.map { String(format: "%02X", $0) }.joined(separator: ":")
    }

    /// Compares two fingerprints ignoring separators and case, so a value the
    /// user pasted from a terminal still matches one read off a screen.
    public func matches(_ other: String) -> Bool {
        Self.normalize(value) == Self.normalize(other)
    }

    static func normalize(_ fingerprint: String) -> String {
        fingerprint.uppercased().filter { $0.isHexDigit }
    }
}

/// What the app has decided about a server's certificate.
public enum CertificateTrustDecision: Equatable, Sendable {
    /// Chain validated normally — a real CA. Nothing to ask the user.
    case systemTrusted
    /// Self-signed and already pinned by the user at pairing.
    case pinned(CertificateFingerprint)
    /// Self-signed and unseen. The caller must show the fingerprint and ask.
    case unknown(CertificateFingerprint)
    /// Self-signed, pinned — and the certificate CHANGED. Never auto-accept:
    /// on a shared network this is what an interposer looks like.
    case changed(expected: CertificateFingerprint, received: CertificateFingerprint)
}

/// Decides what to do with a presented certificate given what we pinned before.
/// Pure, so the policy is testable without a live TLS handshake.
public func certificateTrustDecision(
    presented: CertificateFingerprint,
    pinned: CertificateFingerprint?,
    systemTrusted: Bool
) -> CertificateTrustDecision {
    if systemTrusted { return .systemTrusted }
    guard let pinned else { return .unknown(presented) }
    if pinned == presented { return .pinned(presented) }
    return .changed(expected: pinned, received: presented)
}
