import assert from "node:assert/strict";
import { TerminalKeyRepeat, TerminalShift } from "./terminal-key-controls";
import { installTerminalShiftInput, shiftedPhysicalInput, shiftFirstCharacter } from "./terminal-shift-input";

class TestClock {
  now = 0;
  nextID = 0;
  tasks = new Map<number, { time: number; callback: () => void }>();
  set = (callback: () => void, delay: number): number => {
    const id = ++this.nextID;
    this.tasks.set(id, { time: this.now + delay, callback });
    return id;
  };
  clear = (id: number): void => { this.tasks.delete(id); };
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const next = [...this.tasks].sort((a, b) => a[1].time - b[1].time)[0];
      if (!next || next[1].time > end) break;
      this.now = next[1].time;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
}

const clock = new TestClock();
const repeat = new TerminalKeyRepeat(clock);
let deletions = 0;
const press = (): boolean => { deletions++; return true; };
repeat.start(press);
assert.equal(deletions, 1, "press deletes immediately");
clock.advance(399);
assert.equal(deletions, 1);
clock.advance(1);
assert.equal(deletions, 2, "repeat begins at 400ms");
clock.advance(180);
assert.equal(deletions, 5, "repeat every 60ms without acceleration");
repeat.start(press);
assert.equal(deletions, 5, "a second pointer cannot start another hold");
repeat.cancel();
clock.advance(1000);
assert.equal(deletions, 5, "release cancels pending repeats");
for (let tap = 0; tap < 3; tap++) { repeat.start(press); repeat.cancel(); }
clock.advance(1000);
assert.equal(deletions, 8, "rapid taps delete once each");
let connected = true;
repeat.start(() => connected && press());
connected = false;
clock.advance(400);
connected = true;
clock.advance(1000);
assert.equal(deletions, 9, "failed sends stop and reconnection does not restart");
repeat.start(() => { press(); repeat.cancel(); return true; });
clock.advance(1000);
assert.equal(deletions, 10, "cancellation during a send leaves no timer");
assert.equal(clock.tasks.size, 0);

const shift = new TerminalShift();
const states: boolean[] = [];
const unsubscribe = shift.subscribe(() => states.push(shift.active));
shift.toggle(); shift.set(true); shift.toggle();
assert.deepEqual(states, [false, true, false]);
unsubscribe(); shift.toggle();
assert.deepEqual(states, [false, true, false], "disposed views are not updated");
assert.equal(shiftFirstCharacter("abc"), "Abc");
assert.equal(shiftFirstCharacter("1abc"), "!abc");
assert.equal(shiftFirstCharacter("🙂text"), "🙂text");
assert.equal(shiftFirstCharacter("日本語"), "日本語");
assert.equal(shiftFirstCharacter(""), "");
const physical = (key: string, extra = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, getModifierState: () => false, ...extra });
assert.equal(shiftedPhysicalInput(physical("a")), "A");
assert.equal(shiftedPhysicalInput(physical("1")), "!");
assert.equal(shiftedPhysicalInput(physical("A", { shiftKey: true })), "A");
assert.equal(shiftedPhysicalInput(physical("A", { getModifierState: () => true })), "a");
assert.equal(shiftedPhysicalInput(physical("a", { shiftKey: true, getModifierState: () => true })), "a");
assert.equal(shiftedPhysicalInput(physical("Tab")), "\x1b[Z");
assert.equal(shiftedPhysicalInput(physical("ArrowLeft"), true), "\x1b[1;2D");
assert.equal(shiftedPhysicalInput(physical("c", { ctrlKey: true })), "\x03");
assert.equal(shiftedPhysicalInput(physical("Shift")), undefined);
assert.equal(shiftedPhysicalInput(physical("Unidentified")), undefined);

// Exercise the event handlers without a browser. This minimal textarea models
// selection replacement; actual native event ordering still needs browser QA.
class TestInputEvent extends Event {
  constructor(type: string, readonly inputType: string, readonly data: string | null, readonly isComposing = false, cancelable = true) { super(type, { cancelable }); }
}
class TestTextarea extends EventTarget {
  value = "";
  selectionStart = 0;
  selectionEnd = 0;
  selectionDirection = "none";
  classList: { contains: (name: string) => boolean };
  constructor(className: string) { super(); this.classList = { contains: (name) => name === className }; }
  setSelectionRange(start: number, end: number, direction = "none"): void { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  setRangeText(text: string, start: number, end: number, mode: string): void {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    if (mode === "end") this.setSelectionRange(start + text.length, start + text.length);
  }
}
const savedGlobals = ["HTMLTextAreaElement", "InputEvent", "window"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, "HTMLTextAreaElement", { configurable: true, value: TestTextarea });
Object.defineProperty(globalThis, "InputEvent", { configurable: true, value: TestInputEvent });
Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: clock.set, clearTimeout: clock.clear } });
try {
  const root = new EventTarget();
  const composer = new TestTextarea("terminal-composer-input");
  const terminal = new TestTextarea("xterm-helper-textarea");
  const sent: string[] = [];
  let accepted = true;
  const latch = new TerminalShift();
  const handlers = installTerminalShiftInput({ root: root as HTMLElement, shift: latch, connected: () => connected, applicationCursor: () => false, send: (data) => { if (!accepted) return false; sent.push(data); return true; } });
  const fire = (target: TestTextarea, event: Event): Event => {
    Object.defineProperty(event, "target", { value: target });
    root.dispatchEvent(event);
    return event;
  };
  const key = (target: TestTextarea, name: string, extra = {}): Event => fire(target, Object.assign(new Event("keydown", { cancelable: true }), physical(name, extra)));
  latch.set(true);
  assert.equal(key(terminal, "Tab").defaultPrevented, true);
  assert.deepEqual(sent, ["\x1b[Z"]);
  assert.equal(latch.active, false);
  key(terminal, "a");
  assert.equal(sent.length, 1, "unshifted events remain with xterm");

  latch.set(true);
  key(terminal, "Shift");
  assert.equal(latch.active, true, "modifier alone does not consume Shift");
  assert.equal(key(terminal, "v", { ctrlKey: true }).defaultPrevented, false);
  fire(terminal, new TestInputEvent("beforeinput", "insertFromPaste", "hello"));
  assert.equal(latch.active, true);
  accepted = false;
  assert.equal(key(terminal, "a").defaultPrevented, true, "failed shifted input cannot fall through as an unshifted key");
  assert.equal(latch.active, true, "a failed send does not consume Shift");
  accepted = true;
  fire(terminal, new TestInputEvent("beforeinput", "insertText", "ab"));
  assert.equal(sent.at(-1), "Ab");
  assert.equal(latch.active, false);
  fire(terminal, new TestInputEvent("input", "insertText", "ab"));
  assert.equal(sent.length, 2, "fallback event cannot send a handled edit twice");

  latch.set(true);
  fire(terminal, new TestInputEvent("beforeinput", "insertText", "1", false, false));
  assert.equal(latch.active, true);
  assert.equal(fire(terminal, new TestInputEvent("input", "insertText", "1")).defaultPrevented, true);
  assert.equal(sent.at(-1), "!", "non-cancelable mobile edits are intercepted before xterm");

  composer.value = "hello"; composer.setSelectionRange(5, 5);
  latch.set(true);
  key(composer, "Enter");
  assert.equal(composer.value, "hello\n", "Shift+Enter inserts a composer newline without submitting");
  latch.set(true);
  key(composer, "a");
  assert.equal(composer.value, "hello\nA");
  latch.set(true);
  key(composer, "ArrowLeft");
  assert.deepEqual([composer.selectionStart, composer.selectionEnd], [6, 7]);
  latch.set(true);
  key(composer, "Backspace");
  assert.equal(composer.value, "hello\n");
  composer.value = "🙂"; composer.setSelectionRange(2, 2);
  latch.set(true); key(composer, "Backspace");
  assert.equal(composer.value, "", "delete preserves Unicode code points");

  latch.set(true);
  fire(terminal, new Event("compositionstart"));
  fire(terminal, new TestInputEvent("beforeinput", "insertCompositionText", "a", true));
  assert.equal(latch.active, true, "active composition is untouched");
  fire(terminal, Object.assign(new Event("compositionend"), { data: "abc" }));
  assert.equal(handlers.handleCompositionData("\x1b[1;2R"), false, "terminal replies are untouched");
  assert.equal(handlers.handleCompositionData("abc"), true);
  assert.equal(sent.at(-1), "Abc");
  assert.equal(handlers.handleCompositionData("later"), false);
  clock.advance(0);

  composer.value = "hello "; composer.setSelectionRange(6, 6);
  latch.set(true);
  fire(composer, new Event("compositionstart"));
  composer.value = "hello abc"; composer.setSelectionRange(9, 9);
  fire(composer, Object.assign(new Event("compositionend"), { data: "abc" }));
  fire(composer, new TestInputEvent("input", "insertText", "abc"));
  clock.advance(0);
  assert.equal(composer.value, "hello Abc");
  assert.equal(latch.active, false);

  composer.value = "a"; composer.setSelectionRange(0, 1);
  latch.set(true);
  fire(composer, new Event("compositionstart"));
  composer.setSelectionRange(1, 1);
  fire(composer, Object.assign(new Event("compositionend"), { data: "a" }));
  clock.advance(0);
  assert.equal(composer.value, "A", "replacing selected text with the same committed letter still consumes Shift");
  composer.value = "a"; composer.setSelectionRange(0, 1);
  latch.set(true);
  fire(composer, new Event("compositionstart"));
  fire(composer, Object.assign(new Event("compositionend"), { data: "" }));
  clock.advance(0);
  assert.equal(composer.value, "a", "canceled composition does not alter selected text");
  assert.equal(latch.active, true);

  latch.set(true);
  fire(terminal, new Event("compositionstart"));
  fire(terminal, Object.assign(new Event("compositionend"), { data: "a" }));
  fire(terminal, new Event("paste"));
  assert.equal(handlers.handleCompositionData("pasted"), false);
  assert.equal(latch.active, true);
  handlers.reset();
  handlers.dispose();
  assert.equal(clock.tasks.size, 0);
  key(terminal, "a");
  assert.equal(latch.active, true, "disposed handlers cannot intercept input");
} finally {
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}
console.log("terminal Shift and Backspace repeat controls passed");
