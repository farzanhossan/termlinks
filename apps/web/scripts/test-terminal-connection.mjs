import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import vm from "node:vm";
import { build, transform } from "esbuild";

// Run production connection code with a deterministic clock and transport.
// xterm itself is used for the visible-prompt regression below.
const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
function section(start, next) {
  const from = source.indexOf(start), to = source.indexOf(next, from);
  assert.ok(from >= 0 && to > from, `Missing production section: ${start}`);
  return source.slice(from, to);
}
const { code } = await transform([
  section("class EncryptedTerminalLink", "class EncryptedDesktopLink"),
  section("class EncryptedBridge", "function describeSessionExit"),
  section("function logConnectionFailure", "window.setInterval(() => { void checkPortalConnection()"),
  section("function sendTerminalInput", "function setTerminalInputStatus"),
  section("function connectTerminal", "function fitTerminal"),
  "globalThis.Bridge = EncryptedBridge;",
].join("\n"), { loader: "ts", target: "es2022" });
const bundled = await build({ entryPoints: [new URL("../src/terminal-reconnect.ts", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "esm" });
const stream = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);
const flush = () => new Promise(resolve => setImmediate(resolve));
class Clock {
  now = 0; id = 0; timers = new Map(); microtasks = [];
  setTimeout = (callback, ms) => { const id = ++this.id; this.timers.set(id, { callback, at: this.now + ms }); return id; };
  clearTimeout = id => this.timers.delete(id);
  queueMicrotask = callback => this.microtasks.push(callback);
  drain() { while (this.microtasks.length) this.microtasks.shift()(); }
  advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at; this.timers.delete(next[0]); next[1].callback();
    }
    this.now = end;
  }
}
class Socket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 1; sent = []; closes = []; listeners = new Map();
  addEventListener(name, callback) { const set = this.listeners.get(name) ?? new Set(); set.add(callback); this.listeners.set(name, set); }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  send(value) { if (this.sendError) throw this.sendError; this.sent.push(value); }
  close(code = 1000) {
    // Match browser restrictions: the old 1008 close aborted failure cleanup.
    if (code !== 1000 && (code < 3000 || code > 4999)) throw new Error("InvalidAccessError");
    this.closes.push(code); this.readyState = 3;
  }
}
function fixture() {
  const clock = new Clock(), diagnostics = [], encrypted = [];
  let id = 0, generation = 0, resumes = 0, logins = 0;
  const context = vm.createContext({
    ...stream, WebSocket: Socket, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Blob, Error,
    window: clock, document: { visibilityState: "visible", querySelector: () => ({}) },
    console: { warn: (...args) => diagnostics.push(args) },
    crypto: { randomUUID: () => `request-${++id}` },
    bytesToBase64URL: bytes => Buffer.from(bytes).toString("base64url"),
    base64URLToBytes: value => new Uint8Array(Buffer.from(value, "base64url")),
    encryptPacket: async (_key, channel, _direction, sequence, value) => { encrypted.push({ channel, sequence, value }); return "ciphertext"; },
    decryptPacket: async (_key, _channel, _direction, _sequence, packet) => JSON.parse(packet),
    encryptedPortal: true, encryptedBridge: undefined, portalResumeKey: {},
    authGeneration: { current: () => generation, owns: value => value === generation },
    state: { authenticated: true, sessions: [], terminalInputReady: true, terminalReconnectAttempts: 0 },
    setConnectionState: (_label, kind) => { context.state.terminalInputReady = kind === "online"; },
    resumeEncryptedPortal: async () => { if (!context.state.authenticated) resumes++; },
    clearLocalLogin: async () => { logins++; context.state.authenticated = false; },
    renderLogin: () => { logins++; }, fitTerminal: () => {},
    loadTerminalHistory: async () => {}, describeSessionExit: () => "Exited",
  });
  vm.runInContext(code, context);
  function bridge() {
    const bridge = new context.Bridge(); bridge.socket = new Socket(); bridge.key = {}; bridge.channel = `channel-${++id}`;
    context.encryptedBridge = bridge; context.state.authenticated = true;
    return bridge;
  }
  return { context, clock, diagnostics, encrypted, bridge, invalidate: () => generation++, resumes: () => resumes, logins: () => logins };
}

// A send interruption closes the entire bridge, observes all pending promises,
// and leaves no rejected queue pretending to be a healthy connection.
{
  const f = fixture(), b = f.bridge(), socket = b.socket;
  let closed = 0;
  const link = b.openTerminal("session", { open() {}, close() { closed++; }, error() {}, message() {} });
  link.markOpen(); await flush();
  socket.sendError = new Error("do not log secret input");
  const pending = b.request("GET", "/api/sessions");
  const listing = b.listWindows();
  const results = await Promise.allSettled([pending, listing, b.sendTerminalData(link.id, new Uint8Array([97]))]);
  assert.ok(results.every(result => result.status === "rejected"));
  assert.equal(b.isReady(), false); assert.equal(closed, 1);
  assert.deepEqual(socket.closes, [4000]);
  assert.equal(f.clock.timers.size, 0);
  f.clock.drain(); assert.equal(f.resumes(), 1);
  assert.ok(!JSON.stringify(f.diagnostics).includes("secret input"));
  const sent = socket.sent.length;
  await assert.rejects(b.sendTerminalData(link.id, new Uint8Array([98])));
  assert.equal(socket.sent.length, sent, "uncertain input must never be replayed");
  const replacement = f.bridge();
  await replacement.sendTerminalData("new-terminal", new Uint8Array([99]));
  assert.equal(f.encrypted.at(-1).sequence, 0, "replacement uses a fresh channel/sequence");
}

// One heartbeat for overlapping callers; no response on an OPEN socket causes
// bounded recovery. HTTP errors that are responses still prove transport life.
{
  const f = fixture(), b = f.bridge();
  const first = b.checkHealth(), second = b.checkHealth();
  assert.equal(first, second);
  const failure = assert.rejects(first, /did not respond/);
  await flush(); assert.equal(f.encrypted.length, 1);
  f.clock.advance(14999); assert.equal(b.isReady(), true);
  f.clock.advance(1); await failure; f.clock.drain();
  assert.equal(b.isReady(), false); assert.equal(f.resumes(), 1);
  assert.equal(f.clock.timers.size, 0);
}
for (const status of [204, 503]) {
  const f = fixture(), b = f.bridge(), pending = b.checkHealth();
  await flush(); const id = f.encrypted.at(-1).value.id;
  await b.receive(JSON.stringify({ v: 2, type: "http_response", id, status, body: "" }));
  assert.equal(await pending, status); assert.equal(b.isReady(), true);
  assert.equal(f.clock.timers.size, 0);
}

// Closing during asynchronous encryption cannot send a reserved packet later.
{
  const f = fixture(), b = f.bridge(), socket = b.socket;
  let finishEncryption;
  f.context.encryptPacket = () => new Promise(resolve => { finishEncryption = resolve; });
  const sending = b.sendTerminalData("terminal", new Uint8Array([97]));
  const failure = assert.rejects(sending, /disconnected/);
  await flush(); b.close(); finishEncryption("ciphertext"); await failure;
  assert.equal(socket.sent.length, 0);
}

// Wake checks probe even while authenticated; stale results cannot log out or
// close a replacement bridge. Hidden tabs do not initiate health checks.
{
  const f = fixture(), old = f.bridge();
  const checking = f.context.checkPortalConnection();
  await flush(); assert.equal(f.encrypted.length, 1);
  const id = f.encrypted[0].value.id;
  f.invalidate(); const replacement = f.bridge();
  await old.receive(JSON.stringify({ v: 2, type: "http_response", id, status: 401, body: "" }));
  await checking; assert.equal(f.logins(), 0); assert.equal(replacement.isReady(), true);
  f.context.document.visibilityState = "hidden";
  await f.context.checkPortalConnection(); assert.equal(f.encrypted.length, 1);
}
{
  const f = fixture(), old = f.bridge();
  const checking = f.context.checkPortalConnection(); await flush();
  const replacement = f.bridge();
  f.clock.advance(15000); await checking; f.clock.drain();
  assert.equal(old.isReady(), false); assert.equal(replacement.isReady(), true);
  assert.equal(f.context.state.authenticated, true); assert.equal(f.resumes(), 0);
}
{
  const f = fixture(), b = f.bridge();
  const checking = f.context.checkPortalConnection(); await flush();
  await b.receive(JSON.stringify({ v: 2, type: "http_response", id: f.encrypted[0].value.id, status: 401, body: "" }));
  await checking; assert.equal(f.logins(), 1, "current credential revocation still signs out");
}

// Greeting timeout removes listeners and closes the orphan socket.
{
  const f = fixture(), socket = new Socket();
  const pending = f.context.waitForBridge(socket);
  const failure = assert.rejects(pending, /timed out/);
  f.clock.advance(15000); await failure;
  assert.equal(socket.readyState, Socket.CLOSED);
  assert.ok([...socket.listeners.values()].every(set => set.size === 0));
}

function terminalFixture() {
  const f = fixture(), links = [], writes = [], completedWrites = [];
  const session = { id: "shell", running: true };
  Object.assign(f.context.state, { selected: session.id, sessions: [session], terminalSessionID: session.id, terminalSnapshotApplied: true });
  f.context.state.terminal = {
    buffer: { active: { viewportY: 0, baseY: 0 } },
    reset() { writes.length = 0; },
    write(data, done) { writes.push(new TextDecoder().decode(data)); if (done) completedWrites.push(done); },
    scrollToBottom() {}, scrollToLine() {},
  };
  f.context.encryptedBridge = {
    isReady: () => true,
    openTerminal(_id, callbacks) { const link = new Socket(); link.readyState = 0; link.callbacks = callbacks; links.push(link); return link; },
  };
  const open = () => { const link = links.at(-1); link.readyState = 1; link.callbacks.open(); return link; };
  const control = (link, type, extra = {}) => link.callbacks.message(JSON.stringify({ type, ...extra }));
  return { ...f, session, links, writes, completedWrites, open, control };
}

// Terminal open and snapshot deadlines retry with increasing backoff. Merely
// opening a socket must not reset backoff or prematurely enable App Keyboard.
{
  const f = terminalFixture();
  f.context.connectTerminal(f.session);
  f.clock.advance(15000); assert.equal(f.links[0].readyState, 3);
  f.clock.advance(500); assert.equal(f.links.length, 2);
  const second = f.open(); f.clock.advance(400);
  assert.equal(f.context.state.terminalInputReady, false);
  assert.equal(f.context.state.terminalReconnectAttempts, 1);
  f.control(second, "terminal_snapshot_start", { bytes: 3 });
  second.callbacks.message(new TextEncoder().encode("ab").buffer);
  f.clock.advance(15000); assert.equal(second.readyState, 3);
  assert.deepEqual(f.writes, [], "partial snapshot never replaces the visible terminal");
  f.clock.advance(999); assert.equal(f.links.length, 2);
  f.clock.advance(1); assert.equal(f.links.length, 3);
  const third = f.open();
  f.control(third, "terminal_snapshot_start", { bytes: 3 });
  third.callbacks.message(new TextEncoder().encode("abc").buffer);
  f.control(third, "terminal_snapshot_end");
  assert.equal(f.context.state.terminalInputReady, false, "wait for xterm to apply snapshot");
  f.completedWrites.shift()();
  assert.equal(f.context.state.terminalInputReady, true);
  assert.equal(f.context.state.terminalReconnectAttempts, 0);
  third.callbacks.message(new TextEncoder().encode("live").buffer);
  assert.deepEqual(f.writes, ["abc", "live"]);
  f.clock.advance(20000); assert.equal(f.links.length, 3);
}

// Error events close OPEN sockets before scheduling, and callbacks from a
// replaced connection cannot enable input or overwrite current output.
{
  const f = terminalFixture(); f.context.connectTerminal(f.session);
  const old = f.open();
  f.control(old, "terminal_snapshot_start", { bytes: 1 });
  old.callbacks.message(new Uint8Array([97]).buffer); f.control(old, "terminal_snapshot_end");
  old.callbacks.error(); assert.equal(old.readyState, 3);
  f.completedWrites.shift()(); assert.equal(f.context.state.terminalInputReady, false);
  f.clock.advance(500); assert.equal(f.links.length, 2);
  f.control(old, "terminal_snapshot_end");
  assert.equal(f.links[1].readyState, 0);
  f.context.state.terminalConnectCleanup();
  f.clock.advance(20000); assert.equal(f.links.length, 2, "navigation cancels sync timers");
}

// Actual xterm history: direct App Keyboard sends must reveal the updated
// prompt without locally echoing text or generating a duplicate input event.
{
  const require = createRequire(import.meta.url);
  const { Terminal } = require("@xterm/xterm");
  const terminal = new Terminal({ cols: 40, rows: 5, scrollback: 100, scrollOnUserInput: true });
  try {
    const f = fixture(), socket = new Socket(); let aligned = 0, localInputs = 0;
    Object.assign(f.context.state, { terminal, socket, touchSync: () => aligned++ });
    terminal.onData(() => localInputs++);
    const write = text => new Promise(resolve => terminal.write(text, resolve));
    await write(Array.from({ length: 20 }, (_, i) => `history ${i}\r\n`).join("") + "prompt> abc");
    terminal.scrollToTop();
    assert.equal(f.context.sendTerminalInput("\x7f"), true); await write("\b \b");
    assert.equal(f.context.sendTerminalInput("d"), true); await write("d");
    assert.equal(terminal.buffer.active.viewportY, terminal.buffer.active.baseY);
    assert.equal(terminal.buffer.active.getLine(terminal.buffer.active.baseY + terminal.buffer.active.cursorY).translateToString(true), "prompt> abd");
    assert.deepEqual(socket.sent.map(bytes => new TextDecoder().decode(bytes)), ["\x7f", "d"]);
    assert.equal(aligned, 2); assert.equal(localInputs, 0);
    terminal.scrollToTop(); await write("incoming only");
    assert.equal(terminal.buffer.active.viewportY, 0, "incoming output preserves history reading");
    f.context.state.terminalInputReady = false;
    assert.equal(f.context.sendTerminalInput("x"), false);
    assert.equal(socket.sent.length, 2); assert.equal(aligned, 2);
    f.context.state.terminalInputReady = true; socket.readyState = Socket.CLOSED;
    assert.equal(f.context.sendTerminalInput("x"), false);
    assert.equal(terminal.buffer.active.viewportY, 0);
    socket.readyState = Socket.OPEN; socket.sendError = new Error("Socket closed during send");
    assert.equal(f.context.sendTerminalInput("x"), false);
    assert.equal(terminal.buffer.active.viewportY, 0);
    assert.equal(aligned, 2, "failed send must not move the viewport");
  } finally { terminal.dispose(); }
}
console.log("terminal display, bridge health and reconnect regression tests passed");
