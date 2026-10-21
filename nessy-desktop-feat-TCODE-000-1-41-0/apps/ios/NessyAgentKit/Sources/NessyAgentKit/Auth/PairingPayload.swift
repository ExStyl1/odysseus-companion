import Foundation

/// NESSY DEVIATION (F5): the pairing payload a QR code carries.
///
/// Mirrors `packages/shared/src/pairing/pairing-url.ts` — the desktop's Server
/// settings render it as a QR and `nessy-server` prints it as a link, so the
/// two parsers must agree exactly. The shared test vectors live on both sides.
///
/// The fingerprint travels with it on purpose: a QR shown on the machine
/// running the server is a trusted side channel, so scanning it off that screen
/// already establishes what F1's manual 64-character comparison was asking a
/// human to establish — and a check people skip is worse than one they cannot.
public struct PairingPayload: Equatable, Sendable {
    public let url: URL
    public let token: String
    /// Present when the server's certificate is self-signed.
    public let fingerprint: CertificateFingerprint?

    public init(url: URL, token: String, fingerprint: CertificateFingerprint? = nil) {
        self.url = url
        self.token = token
        self.fingerprint = fingerprint
    }

    /// Parses a scanned string. Returns `nil` for anything that is not one of
    /// ours: a camera sees a lot of QR codes, and a wrong one must read as "not
    /// a pairing code" — never as a crash, never as a half-filled form.
    public init?(scanned raw: String) {
        guard let components = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme == "nessy",
              components.host == "pair",
              let items = components.queryItems
        else { return nil }

        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        guard let urlString = value("url"), !urlString.isEmpty,
              let token = value("token"), !token.isEmpty,
              let url = URL(string: urlString),
              // Websocket schemes only. A pairing code pointing at https is not
              // ours, and honouring it would be following a redirect we never
              // intended to allow.
              url.scheme == "ws" || url.scheme == "wss"
        else { return nil }

        self.url = url
        self.token = token
        if let fingerprint = value("fp"), !fingerprint.isEmpty {
            self.fingerprint = CertificateFingerprint(value: fingerprint)
        } else {
            self.fingerprint = nil
        }
    }
}
