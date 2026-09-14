import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { transform } from "esbuild";

// Exercise the production functions without executing main.ts's DOM/bootstrap
// side effects. Keep the bridge and timing deferred so the race is repeatable.
const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
function functionSection(start, next) {
  const from = source.indexOf(start);
  const to = source.indexOf(next, from);
  assert.ok(from >= 0 && to > from, `Missing production section: ${start}`);
  return source.slice(from, to);
}
const functions = [
  functionSection("async function resumeEncryptedPortal()", "async function boot()"),
  functionSection("function beginManualPortalLogin()", "async function clearLocalLogin("),
].join("\n");
const { code } = await transform(functions, { loader: "ts", target: "es2022" });
const generationSource = await readFile(new URL("../src/auth-generation.ts", import.meta.url), "utf8");
const generationCode = await transform(generationSource, { loader: "ts", format: "esm" });
const { AuthGeneration } = await import(`data:text/javascript;base64,${Buffer.from(generationCode.code).toString("base64")}`);

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  const handshakes = [];
  const attempts = [];
  class Bridge {
    issuedCredential = { id: "fresh-device", secret: "fresh-secret" };
    closed = false;
    connectWithKey(key, deviceID) {
      attempts.push({ bridge: this, key, deviceID });
      return handshakes.shift()?.promise ?? Promise.resolve();
    }
    // Deliberately let an outstanding handshake settle after close: cancellation
    // must remain safe even when the async operation has already completed.
    close() { this.closed = true; }
  }
  const context = vm.createContext({
    encryptedPortal: true, portalResumeKey: "saved-key", portalDeviceID: "saved-device",
    portalReconnect: undefined, portalReconnectTimer: 0, encryptedBridge: undefined,
    authGeneration: new AuthGeneration(), pendingAuthBridges: new Set(), loginAbort: undefined,
    EncryptedBridge: Bridge, AbortController, LOGGED_OUT_KEY: "logged-out",
    state: { authenticated: false, sessions: [], view: "sessions" },
    document: { visibilityState: "visible", querySelector: () => null },
    window: { clearTimeout: () => {}, setTimeout: () => 1, alert: () => {} },
    localStorage: { removeItem: () => {} },
    deriveEncryptionKey: async (secret) => `key:${secret}`,
    deviceLabel: () => "Test browser",
    clearPortalResumeKey: async () => {}, savePortalResumeKey: async () => true,
    loadSessions: async () => {}, setConnectionState: () => {}, renderSessions: () => {},
    renderLogin: () => {},
  });
  vm.runInContext(code, context);
  return { context, handshakes, attempts };
}

async function manualLogin(context) {
  context.beginManualPortalLogin();
  await context.loginPortal("replacement-token", false);
  context.state.authenticated = true; // The production login form publishes this.
}

// Finding 2: a completed superseded restore must not block a later reconnect.
{
  const { context, handshakes, attempts } = fixture();
  const stale = deferred(); handshakes.push(stale);
  const restoring = context.resumeEncryptedPortal();
  const originalBridge = attempts[0].bridge;
  await manualLogin(context);
  assert.equal(originalBridge.closed, true, "manual login must close the pending restoration");
  const freshBridge = context.encryptedBridge;
  stale.resolve(); await restoring;
  assert.equal(context.portalReconnect, undefined, "settled restoration must release its slot");
  assert.equal(context.encryptedBridge, freshBridge, "stale restore must not replace a successful manual login");
  context.state.authenticated = false; context.encryptedBridge = undefined;
  await context.resumeEncryptedPortal();
  assert.equal(attempts.length, 4, "expected restore, bootstrap, manual device login, and subsequent reconnect");
  assert.equal(attempts[3].deviceID, "fresh-device");
  assert.equal(context.state.authenticated, true);
}

// An old completion must not erase a newer pending attempt or permit duplicates.
{
  const { context, handshakes, attempts } = fixture();
  const stale = deferred(); handshakes.push(stale);
  const restoring = context.resumeEncryptedPortal();
  await manualLogin(context);
  context.state.authenticated = false; context.encryptedBridge = undefined;
  const fresh = deferred(); handshakes.push(fresh);
  const reconnecting = context.resumeEncryptedPortal();
  const currentAttempt = context.portalReconnect;
  stale.resolve(); await restoring;
  assert.equal(context.portalReconnect, currentAttempt, "stale completion cleared the newer attempt");
  const joined = context.resumeEncryptedPortal();
  assert.equal(attempts.length, 4, "overlapping reconnect calls must share the current attempt");
  fresh.resolve(); await Promise.all([reconnecting, joined]);
  assert.equal(context.portalReconnect, undefined);
  assert.equal(context.state.authenticated, true);
}

// A failed manual login still cancels restoration and permits another login.
{
  const { context, handshakes } = fixture();
  const stale = deferred(); handshakes.push(stale);
  const restoring = context.resumeEncryptedPortal();
  context.beginManualPortalLogin();
  const denied = deferred(); handshakes.push(denied);
  const signingIn = context.loginPortal("wrong-token", false);
  const failure = assert.rejects(signingIn, /denied/);
  denied.reject(new Error("denied")); await failure;
  stale.resolve(); await restoring;
  assert.equal(context.portalResumeKey, undefined, "cancelled restoration credential must not be reused");
  assert.equal(context.portalReconnect, undefined);
  await manualLogin(context);
  context.state.authenticated = false; context.encryptedBridge = undefined;
  await context.resumeEncryptedPortal();
  assert.equal(context.state.authenticated, true);
}

console.log("portal manual-login and reconnect coordination passed");
