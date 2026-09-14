# Device access and QR login — follow-up review

Reviewed on 2026-09-14 after the fixes to the [original review](device-access-and-qr-login-review.md). This pass examined the changed authentication, logout, stream tracking, and browser reconnect code, their regression tests, and the updated security/plan documentation. The original review is preserved.

**Result: all three previous P2 findings are resolved. No new actionable findings were identified in the reviewed fixes.**

## Previous findings

| Finding | Status | Verification |
| --- | --- | --- |
| Expired temporary-device logout left its device and streams active | Resolved | Session ownership survives expiry for revocation; logout resolves the device without requiring a valid API session. The original controlled-clock handler reproduction now passes. |
| Manual login during restoration blocked later reconnects | Resolved | Manual login clears the previous reconnect state and closes pending bridges. Reconnect completion clears the slot only when its promise still owns it. The original deferred-handshake scenario now opens a second connection successfully. |
| Removing B disconnected A's older terminal after session renewal | Resolved | Streams retain device identity, and revocation closes only that device's streams. The original two-device renewal reproduction now passes. |

The retained ownership entries do not replace session validation: protected API routes still require `Valid`, and `Track` rejects expired sessions when opening new streams. Device revocation removes its ownership entries, while rotation clears all ownership and closes every tracked stream.

The new backend tests cover ownership retention through validation, login cleanup, and renewal; rejection of expired-session access/new streams; unknown and repeated logout; and isolation between original and renewed streams. The new browser test runs the production login/reconnect functions with deferred handshakes and covers stale completion, preservation of a newer pending attempt, and recovery after a failed manual login. It is included in the normal web test command.

## Verification performed

- `npm test` — passed, including the new portal authentication test, both typechecks, and all backend packages.
- `go test -race -count=1 -ldflags=-linkmode=external ./internal/auth ./internal/cloud ./internal/server ./cmd/termlinks` — passed.
- Original backend review probes, supplied through temporary Go overlay files — both passed: `TestReviewLogoutRevokesExpiredTemporaryDevice` and `TestReviewRevokeDoesNotCloseOtherRenewedDevice`.
- Independent deferred-handshake reproduction using the current production reconnect function — passed: `settledReconnectRetained=false`, `connectAttempts=2`, `authenticated=true`.
- Production web bundling — passed with output generated in memory.
- Backend production compilation — passed with the binary written under `/tmp/termlinks-review-20260914-followup/`.

Go verification used elevated execution where required for the build cache and temporary integration-test sockets. No installed service or real credential store was used.

## Remaining verification limits

Browser UI inspection, actual multi-tab/offline behavior in browsers, QR image loading under deployed content policies, and physical iPhone/Android camera scanning remain unverified in this follow-up. The deferred-handshake tests validate application coordination with mocked bridge/timing dependencies. The existing integration coverage still does not exercise active desktop, selected-window, and upload channels during revocation/subscription loss. These are remaining coverage limits, not reproduced failures in the fixes.

Only this follow-up report was added. No existing source, test, configuration, plan, or review file was modified during this review.
