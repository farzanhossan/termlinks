# Device access and QR login — code review

Reviewed on 2026-09-14 against `docs/plans/device-access-and-qr-login.md`. Scope: the tracked and untracked implementation in the working tree based on commit `70d2ddd`, including daemon authentication, device persistence, connector/relay protocol, CLI rotation/QR output, browser login/logout, scanner, and tests.

**Result: three actionable P2 findings.** The existing automated checks pass, but isolated reproductions exposed gaps in reconnect cancellation and device/stream handling after session expiry. No implementation files were changed. This report is the only repository file added by the review.

## Findings

### 1. [P2] Expired temporary-device logout reports success without revoking the device or closing its streams

**Location:** [server.go](../../apps/backend/internal/server/server.go), lines 747–765; related session cleanup in [auth.go](../../apps/backend/internal/auth/auth.go), lines 108–110.

The logout handler resolves the device only if `Valid(cookie.Value)` succeeds, or if a remembered-device cookie can resume it. After a temporary login's twelve-hour session expires, `Valid` deletes its ownership entry and returns false. Temporary logins have no resume cookie, so `id` stays empty, `Revoke` is skipped, and the handler returns HTTP 204. `Logout` only deletes the session map entry; it does not close tracked streams. An already-open terminal therefore remains active on the server and the device remains registered, despite the successful logout response.

**Reproduction:** Log in directly with `remember: false`, register an active stream using that session, advance the authentication clock beyond `SessionDuration`, and POST `/api/logout` with the original session cookie. An isolated handler test returned:

```text
logout returned 204 but streamClosed=false, remainingDevices=1
```

This exercises the real handler and stream-registration mechanism, using a callback to observe closure. The browser closes its own connections during local logout, but that does not satisfy server revocation of all associated connections.

**Suggested correction:** Retain enough device ownership information to revoke an expired session's device, or expire temporary credentials and close their streams together. Do not report confirmed server logout while that device's existing streams remain active. Add coverage for temporary login expiry; the existing expired-session logout test covers remembered cookies only.

### 2. [P2] Manual login during saved-login restoration leaves reconnect permanently blocked

**Location:** [main.ts](../../apps/web/src/main.ts), lines 1199–1201; related guards at lines 1133–1135 and login generation change at line 1496.

The restoration screen allows a manual login while `resumeEncryptedPortal()` is awaiting its handshake. Submitting that login invalidates the authentication generation. When the old restoration finishes, its `finally` returns early because it no longer owns the generation, leaving `portalReconnect` pointing to a settled promise. `loginPortal()` does not reset that promise. After the fresh login subsequently loses its connection, every reconnect call awaits the old promise and returns without opening a new bridge. Reloading the page clears the stuck state.

**Reproduction:** Execute the current `resumeEncryptedPortal()` function with a deferred handshake, invalidate its generation as the login form does, install a fresh credential, release the old handshake, and request another reconnect. The isolated JavaScript harness produced:

```json
{"settledReconnectRetained":true,"connectAttempts":1,"expectedConnectAttempts":2}
```

**Suggested correction:** Cancel/reset the previous reconnect when manual login starts, and clear the reconnect promise by checking its identity so an old completion cannot erase a newer attempt. Test the actual reconnect/login coordination, beyond the standalone generation-counter test.

### 3. [P2] Removing one device also disconnects another device's older terminal stream

**Location:** [devices.go](../../apps/backend/internal/auth/devices.go), lines 340–345; related expiry cleanup at lines 167–170 and revocation call at line 257.

Streams are associated with their original HTTP session string. Session renewal removes expired sessions but does not move an existing terminal stream to the renewed session. Later, `Revoke` calls `closeInvalidStreamsLocked()`, which closes every stream whose original session is absent, regardless of which device was removed. Consequently, removing device B can also disconnect a long-running terminal belonging to still-authorized device A after A's original session expires and A renews its login.

**Reproduction:** Register A and B, track A's terminal, advance beyond the original session expiry, resume A to obtain a valid new session, then revoke B. An isolated authentication-manager test returned:

```text
removing B closed A's tracked terminal despite A's valid renewed session=true
```

The managed PTY is not killed, but another device's live terminal connection is interrupted, contrary to the required isolation of device removal.

**Suggested correction:** Associate streams with device identity and scope revocation to that device. Handle session expiry explicitly rather than making an unrelated removal trigger global stream cleanup. Add a two-device test spanning renewal of an existing stream's original session.

## Verification

- `npm test`: web typecheck, browser logic tests, and relay typecheck passed. Its initial backend phase was blocked by sandbox restrictions on binding local TCP/Unix sockets.
- `npm run test:go`: all backend packages passed when rerun with permission to bind temporary test sockets.
- `go test -race -ldflags=-linkmode=external ./internal/auth ./internal/cloud ./internal/server ./cmd/termlinks`: passed.
- Production web bundling with the existing esbuild options: passed, with output generated in memory.
- `go build -trimpath -ldflags='-linkmode=external -s -w' -o /tmp/termlinks-review-20260914/termlinks ./cmd/termlinks`: passed. The normal build/sync pipeline was not run because it rewrites workspace build artifacts.
- The three finding-specific reproductions demonstrated the failures described above. Go probes used temporary overlay files and a controlled authentication clock; the JavaScript probe executed the extracted current function with mocked bridge/timing dependencies. No regression tests were added to the repository.

## Verification limits

The browser runtime reported no available browsers. Desktop/mobile visual inspection, actual browser logout races, QR image loading under the deployed content policy, camera permission/lifecycle behavior, and physical iPhone/Android scanning remain unverified. A possible QR image/content-policy interaction was not counted as a confirmed finding. The existing encrypted integration test exercises a real terminal stream, but does not exercise active desktop, selected-window, or upload channels during revocation/subscription loss. No installed service, real credential store, or public deployment was changed.
