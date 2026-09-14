import assert from "node:assert/strict";
import { AuthGeneration } from "./auth-generation";

const gate = new AuthGeneration();
let release!: () => void;
const generation = gate.current();
let authenticated = false;
const pendingReconnect = new Promise<void>((resolve) => { release = resolve; }).then(() => {
  if (gate.owns(generation)) authenticated = true;
});
gate.invalidate(); // Explicit logout occurs while the handshake is pending.
release(); await pendingReconnect;
assert.equal(authenticated, false);
assert.throws(() => gate.assert(generation), /cancelled/);
const nextLogin = gate.current();
gate.assert(nextLogin);
assert.equal(gate.owns(nextLogin), true);
