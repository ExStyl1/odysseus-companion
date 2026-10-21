# Nessy on iPhone and iPad

The companion app connects to the Nessy Desktop running on your computer. It does not run an agent of its own — the work happens on your machine, and the phone is a way to watch it and answer it.

The point of it is approvals. When an agent stops to ask permission, you can answer it from the phone while the app is open on the same network, instead of walking back to the desk.

## What you can do from the phone

- Browse workspaces, sessions and their history.
- Read replies as they stream.
- **Answer a permission request** — the waiting turn continues the moment you do.
- Stop a running turn, switch model, switch permission mode.
- Send the agent a task that keeps running after you close the app.
- Attach a photo or a file — it is saved into the session on your computer, not just shown once.
- Read the skills and sources a session has available.

An iPad shows the session list and the conversation side by side. A second device does not disconnect the first, so a phone and an iPad can be connected at the same time.

## Turning the server on

The phone talks to the same server the desktop already uses. Enable it in **Settings → Server**, which shows the address, the token, and a QR code carrying both.

The server serves an encrypted connection. Because the certificate is its own rather than one issued by a public authority, it prints a fingerprint the first time — and the phone shows the fingerprint it actually received. Confirm the two match and the pairing is complete. Pairing by QR carries the fingerprint with it, so there is nothing to compare by hand.

If a server you have already paired with ever presents a different certificate, the phone refuses to connect. On a shared network, a changed certificate is what an impostor looks like, so this is not something to click past.

## Pairing

Scan the QR code from **Settings → Server** with the app's *Scan* button. That is the whole flow: address, token and fingerprint travel together.

You can also type the address and token by hand. If you do, include the scheme — a bare `host:port` is treated as encrypted (`wss://`). If your server is running without TLS, the app says so plainly and offers to connect over `ws://` in one tap, stating that the token and everything you send will cross the network unencrypted.

## What the phone is not allowed to do

A remote device cannot switch a session into **bypass permissions**. Every mode up to and including *auto* is available; the one that stops asking for approval altogether is refused by the server. This is enforced on your computer, not merely hidden in the app, so it holds regardless of what is connected.

Browser tools also need the desktop app connected to the same server, and the phone says so rather than failing silently.

## Reach

The app reaches your computer over your local network — the same Wi-Fi. Access from outside that network is not offered; on that network the connection is encrypted, as described above.

No push notification reaches the phone. The number of requests waiting for your answer, on the app icon and in the list, is updated only while the app is open and connected to Nessy Desktop running on your computer; with the app closed, or the desktop app not running, the icon keeps the last number it showed and nothing tells the phone that a request is waiting.

## Themes

The phone reads the same theme files as the desktop, so a theme available on your computer appears in the phone's theme list. Dark is the default. See [themes](themes).
