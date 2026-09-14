import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { transform } from "esbuild";

// Exercise production event handlers with deferred API responses, without booting the portal.
const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
const start = source.indexOf("function createProfileMenu()");
const end = source.indexOf("\nwindow.setInterval", start);
assert.ok(start >= 0 && end > start);
const { code } = await transform(source.slice(start, end), { loader: "ts" });

class Element {
  children = []; attributes = {}; events = {}; parent = null; hidden = false; disabled = false;
  constructor(tag, className, textContent = "") { Object.assign(this, { tag, className, textContent }); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { for (const child of this.children) child.parent = null; this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { (this.events[name] ??= []).push(callback); }
  async fire(name, event = {}) { for (const callback of this.events[name] ?? []) await callback({ preventDefault() {}, stopPropagation() {}, ...event }); }
  focus() { focused = this; }
  select() {}
  showModal() {}
  close() { void this.fire("close"); }
  get isConnected() { return this.tag === "body" || Boolean(this.parent?.isConnected); }
}
let focused;
const body = new Element("body");
const find = (predicate, root = body) => {
  if (predicate(root)) return root;
  for (const child of root.children) { const result = find(predicate, child); if (result) return result; }
};
const text = (value) => find((element) => element.textContent === value);
const tag = (value) => find((element) => element.tag === value);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const requests = [];
let refresh;
let deferredList;
let failSave = false;
let label = "Android · Chrome";
const deviceList = () => ({ devices: [{ id: "device-1", label, current: true, online: true, lastSeen: "2026-09-14T00:00:00Z", createdAt: "2026-09-14T00:00:00Z" }] });
const context = vm.createContext({
  document: { body }, state: { authenticated: true }, Error,
  el: (tag, className, textContent) => new Element(tag, className, textContent),
  createProfileAvatar: () => new Element("svg"),
  window: { setInterval: (callback) => { refresh = callback; return 1; }, clearInterval: () => { refresh = undefined; } },
  api: async (path, init = {}) => {
    requests.push({ path, ...init });
    if (init.method === "PATCH") {
      if (failSave) throw new Error("Could not save device name");
      label = JSON.parse(init.body).label;
      return;
    }
    if (deferredList) return deferredList;
    return deviceList();
  },
});
vm.runInContext(code, context);
const button = context.createProfileMenu();
assert.equal(button.attributes["aria-label"], "Profile");
assert.equal(button.children[0].tag, "svg");
await button.fire("click");
await text("Connected devices").fire("click");
await flush();

// A refresh already in flight must not replace an active edit with stale data.
let finishRefresh;
const staleList = deviceList();
deferredList = new Promise((resolve) => { finishRefresh = resolve; });
refresh();
await text("Rename").fire("click");
const input = tag("input"); input.value = "iPhone 13 Pro";
finishRefresh(staleList); deferredList = undefined; await flush();
assert.equal(tag("input"), input);
assert.equal(input.value, "iPhone 13 Pro");
const beforeRefresh = requests.length;
refresh(); await flush();
assert.equal(requests.length, beforeRefresh, "refresh should pause while editing");

// Cancel does not send a mutation, and restores keyboard focus after refresh.
await text("Cancel").fire("click"); await flush();
assert.equal(tag("input"), undefined);
assert.equal(requests.filter((request) => request.method === "PATCH").length, 0);
assert.equal(focused, text("Rename"));

// Invalid input and failed saves retain the editor and allow retry.
await text("Rename").fire("click");
tag("input").value = " ";
await tag("form").fire("submit");
assert.ok(text("Use a device name of 1–120 characters."));
tag("input").value = "  iPhone   13 Pro  "; failSave = true;
await tag("form").fire("submit");
assert.ok(text("Could not save device name"));
assert.equal(tag("input").disabled, false);
assert.equal(text("Save").disabled, false);
failSave = false;
await tag("form").fire("submit"); await flush();
assert.equal(label, "iPhone 13 Pro");
assert.ok(text("iPhone 13 Pro · This device"));
assert.equal(tag("input"), undefined);
assert.equal(focused, text("Rename"));

// Esc cancels just the edit; closing the dialog stops refresh.
await text("Rename").fire("click");
await tag("input").fire("keydown", { key: "Escape" }); await flush();
assert.equal(tag("input"), undefined);
assert.ok(tag("dialog"));
await text("Close").fire("click");
assert.equal(tag("dialog"), undefined);
assert.equal(refresh, undefined);
console.log("Profile menu rename interactions passed");
