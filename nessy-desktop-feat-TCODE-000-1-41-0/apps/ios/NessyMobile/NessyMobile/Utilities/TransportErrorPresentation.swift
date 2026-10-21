import Foundation
import NessyAgentKit

func isRecoverableConnectionError(_ error: Error) -> Bool {
    if let transportError = error as? RPCTransport.TransportError {
        return transportError.isConnectionUnavailable
    }
    guard let urlError = error as? URLError else { return false }
    switch urlError.code {
    case .timedOut,
         .cannotFindHost,
         .cannotConnectToHost,
         .networkConnectionLost,
         .dnsLookupFailed,
         .notConnectedToInternet,
         .internationalRoamingOff,
         .callIsActive,
         .dataNotAllowed:
        return true
    default:
        return false
    }
}

/// NESSY DEVIATION (F14-UI): what the user is allowed to read.
///
/// The owner screenshotted a reconnect banner rendering
/// `remote(NessyAgentKit.WireError(code: …authFailed, message: "Invalid token"…`
/// verbatim. A Swift type dump is not an error message: it names our internal
/// types, it is untranslatable, and it tells the one person who has to act
/// nothing about what to do. Everything shown to a user now goes through
/// `PresentedError`, and the raw description survives only as a short code in
/// small print so a support conversation still has something to grep for.
struct PresentedError: Equatable {
    /// A full sentence, localized, that says what happened and what to do.
    let message: String
    /// The wire code (`AUTH_FAILED`, `REQUEST_TIMEOUT`, …) for small print.
    /// `nil` when the message alone is the whole story.
    let code: String?

    /// True when the server refused the credential — the caller should send the
    /// user back to pairing rather than retry forever.
    let isCredentialRejection: Bool

    /// F2: true when the failure is "the other end does not speak TLS" — a
    /// `wss://` dial against a plain-`ws` server. Distinct from an unreachable
    /// host, because the useful next step is different: retry over `ws://`.
    let isPlainServerBehindTLSDial: Bool

    init(
        message: String,
        code: String? = nil,
        isCredentialRejection: Bool = false,
        isPlainServerBehindTLSDial: Bool = false
    ) {
        self.message = message
        self.code = code
        self.isCredentialRejection = isCredentialRejection
        self.isPlainServerBehindTLSDial = isPlainServerBehindTLSDial
    }
}

func presentedError(_ error: Error) -> PresentedError {
    if let urlError = error as? URLError, urlError.code == .dataLengthExceedsMaximum {
        return PresentedError(message: String(localized: "This session is too large to load on this device."))
    }
    if let urlError = error as? URLError {
        // F2: a `wss://` dial against a server that speaks plain `ws` fails the
        // TLS handshake, and the system's wording ("An SSL error has occurred")
        // sends the user hunting for a certificate problem that does not exist.
        // Name the actual cause and let the caller offer the one-tap retry.
        if urlError.code == .secureConnectionFailed {
            return PresentedError(
                message: String(localized: "This server is not using TLS. You can connect over ws:// instead, but the token and everything you send will cross the network unencrypted."),
                code: "URL_\(urlError.code.rawValue)",
                isPlainServerBehindTLSDial: true
            )
        }
        return PresentedError(
            message: String(localized: "Can't reach the server. Check that it is running and that this device is on the same network."),
            code: "URL_\(urlError.code.rawValue)"
        )
    }
    guard let transportError = error as? RPCTransport.TransportError else {
        // Last resort. Never the raw type dump: `localizedDescription` at worst
        // reads as a sentence, and the generic line below carries the advice.
        return PresentedError(message: String(localized: "Something went wrong. Try again."))
    }

    switch transportError {
    case .notConnected:
        return PresentedError(message: String(localized: "The server connection is unavailable. Reconnecting..."))
    case .connectionTimedOut:
        return PresentedError(message: String(localized: "Could not reconnect to the server in time."))
    case .requestTimedOut:
        return PresentedError(message: String(localized: "The server took too long to respond."))
    case .messageTooLarge:
        return PresentedError(message: String(localized: "This session is too large to load on this device."))
    case .invalidResponse:
        return PresentedError(message: String(localized: "The server returned an invalid response."))
    case let .remote(wireError):
        return presented(wireError)
    }
}

private func presented(_ wireError: WireError) -> PresentedError {
    let code = wireError.code.wireValue
    switch wireError.code {
    case .authFailed:
        return PresentedError(
            message: String(localized: "Wrong token — check the server token and enter it again."),
            code: code,
            isCredentialRejection: true
        )
    case .protocolVersionUnsupported:
        return PresentedError(
            message: String(localized: "This app and the server speak different protocol versions. Update whichever is older."),
            code: code
        )
    case .channelNotFound, .capabilityUnavailable:
        return PresentedError(
            message: String(localized: "This server does not offer that feature."),
            code: code
        )
    case .clientDisconnected, .clientRequestTimeout, .browserNoCapableClient:
        return PresentedError(
            message: String(localized: "This needs the desktop app to be connected to the same server."),
            code: code
        )
    case .requestTimeout, .transferTimeout:
        return PresentedError(message: String(localized: "The server took too long to respond."), code: code)
    case .transferTooLarge:
        return PresentedError(message: String(localized: "This session is too large to load on this device."), code: code)
    // `SESSION_NOT_IDLE` is "a turn is running"; `SESSION_BUSY` is the runtime
    // switch refusing to race that turn. From the phone both mean the same
    // thing and have the same next step — wait — so they share one sentence
    // rather than inventing a second way to say it.
    case .sessionNotIdle, .sessionBusy:
        return PresentedError(message: String(localized: "That session is busy right now."), code: code)

    // P3.358. These eight all fell to the generic sentence below until
    // 2026-09-04, because the mirror did not know them and every one decoded to
    // `.unknown`. The first two are the worst of it: the server mints a CODE
    // for them precisely so a non-English locale can be told what happened
    // (P2.464), and answering "Something went wrong" is the exact outcome those
    // codes were created to prevent.
    //
    // Wording is taken from the codes' own definitions in
    // `packages/shared/src/protocol/types.ts`, which is where what each one
    // means is written down.
    //
    // RESIDUE, stated rather than hidden: `wireError.message` is still
    // discarded, here as everywhere else in this function. That is the F14-UI
    // rule above — the server's sentence is untranslatable English — and it
    // costs the one bounded detail two of these carry, the refused model id and
    // which document refused it. Surfacing that means putting an identifier in
    // a localized format string, which is a product decision about what a
    // refusal is allowed to name, not a translation fix.
    case .browserManagedDisabled:
        return PresentedError(
            message: String(localized: "Your organization's policy turns off the built-in browser."),
            code: code
        )
    case .modelRestrictedByPolicy:
        return PresentedError(
            message: String(localized: "Your organization's policy does not allow that model. Choose a different one."),
            code: code
        )
    // P6.723. Two more browser refusals the mirror did not know, and both fell
    // to the generic sentence for the same reason as the eight above. They are
    // separate codes because the next step differs: a debugger refusal is about
    // a capability that may be locked off entirely, a navigation refusal is
    // about THIS site not being approved yet. Wording from the codes' own
    // definitions in `packages/shared/src/protocol/types.ts`.
    case .browserCdpDenied:
        return PresentedError(
            message: String(localized: "Developer tools were not allowed for that page. They may be turned off for this server, or the site was never approved."),
            code: code
        )
    case .browserOriginDenied:
        return PresentedError(
            message: String(localized: "That site has not been approved for the built-in browser."),
            code: code
        )
    case .connectionNotSwitchable:
        return PresentedError(
            message: String(localized: "This session can't move to that connection."),
            code: code
        )
    case .connectionInUse:
        return PresentedError(
            message: String(localized: "That connection still has open sessions. Close them first."),
            code: code
        )
    case .worktreeExitUnavailable:
        return PresentedError(
            message: String(localized: "This session is in a worktree it can't leave."),
            code: code
        )
    case .worktreeDirty:
        return PresentedError(
            message: String(localized: "This worktree has uncommitted changes. Commit or discard them first."),
            code: code
        )
    case .runtimeUnhostable:
        return PresentedError(
            message: String(localized: "The server can't start that runtime. It is not installed, not part of this build, or has no usable credential."),
            code: code
        )
    // P6.498. The operator requires the built-in gateway sign-in, so this is a
    // policy refusal the user can act on (sign in to the gateway) rather than a
    // malfunction — which is the whole reason it is a code and not an English
    // server sentence. Wording from the code's own definition in
    // `packages/shared/src/protocol/types.ts`.
    case .connectionGatewayOnly:
        return PresentedError(
            message: String(localized: "Your organization only allows the built-in gateway sign-in, so this connection can't be created or changed."),
            code: code
        )
    // UA12.149 — the server refused to start a session in a project whose
    // stored folder no longer has the identity that was bound (moved,
    // replaced, or its config edited on disk) rather than start it somewhere
    // else. The next step is the project page's re-link, so the sentence
    // names it, per the codes' own definitions in
    // `packages/shared/src/protocol/types.ts`.
    case .projectFolderIdentityChanged:
        return PresentedError(
            message: String(localized: "This project's folder has changed since it was linked. Re-link the project's folder, then try again."),
            code: code
        )
    default:
        // Includes `.unknown(_)` — a server newer than this app. The advice is
        // generic on purpose; the code is what makes the report actionable.
        return PresentedError(message: String(localized: "Something went wrong. Try again."), code: code)
    }
}

/// Kept for call sites that only need the sentence.
func userFacingTransportError(_ error: Error) -> String {
    presentedError(error).message
}
