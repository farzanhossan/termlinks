# Token rotation, QR login, and device management

## Intent and accepted decisions

Keep `termlinks token` showing the existing shared token. Add `--rotate`, terminal QR codes, an in-app scanner, a profile menu, connected-device management, and reliable logout for direct and encrypted cloud portals.

Removing a device permanently revokes its saved credential, without affecting other devices. Someone who still knows the shared token can register again; rotate the token if it has leaked. Any authenticated device may manage devices. A device represents a browser profile/PWA, not hardware identity.

## Implementation

1. Make the daemon authoritative for persistent device credentials, browser sessions, token generations and revocation. Use protected SQLite storage. Exchange shared-token login for an independent device credential. Preserve non-exportable browser keys and HttpOnly direct cookies.
2. Add device listing/removal and authenticated presence. Show label, creation/last-seen time, online state and current-device marker. Revocation closes all associated terminal, desktop, window and upload channels. Connect daemon and connector through a private Unix-socket authentication subscription; fail closed on subscription loss.
3. Add `termlinks token [--rotate] [--url <portal-url>] [--no-qr]`. Keep stdout token-only for scripts. Rotation atomically changes the token, invalidates sessions and credentials, and disconnects remote clients without killing managed PTYs. Serialize state changes and reject unsupported older daemons.
4. Version encrypted device authentication across web, connector, relay and smoke clients. Bootstrap with the shared key, issue a device credential, then reconnect using its key. Do not persist a master-derived browser key. Reject legacy protocol access and require fresh login on migration.
5. Centralize logout and invalidate pending authentication/reconnect generations. Clear saved credentials, cancel reconnects, synchronize tabs, close streams and return to login even when offline. Server logout revokes the current device; show when only local logout could be confirmed.
6. Add Profile with Connected devices and Log out to authenticated screens. Confirm device removal and allow self-removal. Track activity every 15 seconds and show offline after 45 seconds.
7. Display QR codes using a pinned Go encoder. Save an explicitly configured portal URL; never mistake a relay URL for a browser portal. Use a token-only QR until configured. Login URLs use `#termlinks-token=<token>&v=1`, consumed and removed immediately.
8. Add Scan QR with rear-camera scanning, local jsQR decoding, image selection, manual-token fallback and camera cleanup. Permit same-origin camera use in response headers. Require explicit navigation for a QR targeting another portal, and reject unsupported payloads/URL schemes.
9. Update PWA caches, CLI help, README, security and deployment docs. Public deployment is a separate release action.

## Verification

- Token reuse, rotation, concurrent writes, persistence failure, stopped services and restart recovery.
- Two-device isolation, permanent revocation, self-removal and fresh registration with the shared token.
- Rotation invalidates tokens, QR codes, cookies and stored keys while existing managed terminal processes continue.
- Logout during reconnect, pending requests, across tabs and offline; refresh cannot restore revoked access.
- Encrypted integration covers device bootstrap/resume and closure of non-HTTP channels on revocation/subscription loss.
- QR round trips, malformed links, destination changes, camera denial, image scanning and lifecycle cleanup.
- Run `npm test` and `npm run build`; inspect desktop/mobile UI and separately report physical phone-camera checks when unavailable.

## Rollout

Upgrade daemon, connector and hosted portal together. Existing tokens remain unchanged; legacy remembered logins must sign in once again. Do not silently retain a legacy authentication bypass or restart a daemon with running PTYs to activate an upgrade.

## Implementation and verification status

Implemented in the working tree. The registry, private authentication subscription, v2 bridge, CLI rotation/QR output, scanner, profile/device dialog, reconnect cancellation and cross-tab/offline logout are present. The existing dark UI variables are reused. Direct temporary logins use session cookies; remembered direct logins retain a separate HttpOnly resume cookie for up to one year in the browser.

Verified with the complete `npm test` suite, targeted Go race-detector tests for auth/cloud/server/CLI, and the complete application build. An isolated built-binary check confirmed token reuse, two-device removal, rotation, logout, embedded camera headers, and decoding the terminal-rendered QR back into the expected fragment login URL. Integration tests use a local relay, private Unix socket and actual PTY to confirm revocation, legacy/revoked-key rejection, subscription failure and process survival.

The browser runtime reported no available browsers. Visual desktop/mobile inspection and physical iPhone/Android camera scanning remain manual verification items. No installed daemon, existing user credentials, or public deployment was changed.

## Review follow-up — 2026-09-14

Addressed all three P2 findings in [the review](../reviews/device-access-and-qr-login-review.md), preserving the original review report:

- Expired sessions retain hashed device ownership for logout only. Logout revokes the device and all its streams even without a remembered-device cookie; expiry still rejects API access and new streams.
- Manual login cancels saved-login restoration. Completed reconnects clear their slot by promise identity, so a stale completion cannot block future reconnects or erase a newer attempt.
- Streams retain their device identity across HTTP-session renewal. Device removal closes only that device's streams; rotation still closes all streams.

Regression coverage includes all session-expiry cleanup paths, temporary-session handler logout, two-device stream isolation after renewal, and the actual production login/reconnect functions with deferred handshakes. `npm test`, Go race checks for auth/cloud/server/CLI, and `npm run build` passed. Browser and camera verification remain unavailable; no installed service or public deployment was changed.
