import { TerminalKeyRepeat, type TerminalShift } from "./terminal-key-controls";

export type KeyboardLayout = "mac" | "windows";
export type KeyboardModifiers = { shift: boolean; ctrl: boolean; alt: boolean; meta: boolean; caps: boolean };

export function parseKeyboardLayout(value: string | null): KeyboardLayout {
  return value === "windows" ? "windows" : "mac";
}

export function keyboardCharacter(key: string, modifiers: KeyboardModifiers): string {
  if (/^[a-z]$/.test(key)) return modifiers.shift !== modifiers.caps ? key.toUpperCase() : key;
  const normal = "`1234567890-=[]\\;',./";
  const shifted = '~!@#$%^&*()_+{}|:"<>?';
  const index = normal.indexOf(key);
  return modifiers.shift && index >= 0 ? shifted.charAt(index) : key;
}

// PTYs receive characters and escape sequences, rather than desktop key events.
// Both OS layouts use terminal Meta for Option/Alt and Command/Win.
export function terminalKeyboardInput(key: string, modifiers: KeyboardModifiers, applicationCursor = false): string {
  const meta = modifiers.alt || modifiers.meta;
  const parameter = 1 + Number(modifiers.shift) + Number(meta) * 2 + Number(modifiers.ctrl) * 4;
  const cursor: Record<string, string> = { ArrowUp: "A", ArrowDown: "B", ArrowRight: "C", ArrowLeft: "D", Home: "H", End: "F" };
  if (cursor[key]) return parameter > 1 ? `\x1b[1;${parameter}${cursor[key]}` : `\x1b${applicationCursor ? "O" : "["}${cursor[key]}`;
  const tilde: Record<string, number> = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
  if (tilde[key]) return `\x1b[${tilde[key]}${parameter > 1 ? `;${parameter}` : ""}~`;
  const functions: Record<string, string> = { F1: "P", F2: "Q", F3: "R", F4: "S" };
  if (functions[key]) return parameter > 1 ? `\x1b[1;${parameter}${functions[key]}` : `\x1bO${functions[key]}`;
  if (key === "Tab" && modifiers.shift) return "\x1b[Z";
  const special: Record<string, string> = { Enter: "\r", Backspace: modifiers.ctrl ? "\b" : "\x7f", Tab: "\t", Escape: "\x1b", Space: " " };
  let value = special[key] ?? keyboardCharacter(key, modifiers);
  if (modifiers.ctrl && value.length === 1) {
    const code = value.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) value = String.fromCharCode(code - 64);
    else if (value === " " || value === "2") value = "\x00";
    else if (value >= "3" && value <= "7") value = String.fromCharCode(Number(value) + 24);
    else if (value === "8" || value === "?") value = "\x7f";
  }
  return meta ? `\x1b${value}` : value;
}

export function createTerminalKeyboard(options: {
  shift: TerminalShift;
  send: (value: string) => boolean;
  applicationCursor: () => boolean;
  status: (message: string) => void;
  resize: () => void;
}) {
  let connected = false;
  let disposed = false;
  const repeat = new TerminalKeyRepeat({ set: (callback, delay) => window.setTimeout(callback, delay), clear: (id) => window.clearTimeout(id) });
  let heldKey: { button: HTMLButtonElement; pointerId: number } | undefined;
  const cancelRepeat = (): void => {
    repeat.cancel();
    const held = heldKey;
    heldKey = undefined;
    if (held?.button.hasPointerCapture(held.pointerId)) held.button.releasePointerCapture(held.pointerId);
  };
  let layout: KeyboardLayout = /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "windows";
  try {
    const saved = localStorage.getItem("termlinks-app-keyboard-layout");
    if (saved) layout = parseKeyboardLayout(saved);
  } catch { /* Storage can be unavailable in private browsing. */ }
  const modifiers: KeyboardModifiers = { shift: false, ctrl: false, alt: false, meta: false, caps: false };
  const makeButton = (label: string, className: string): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    return button;
  };
  const button = makeButton("App Keyboard", "terminal-app-keyboard-button");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "terminal-app-keyboard");
  const panel = document.createElement("section");
  panel.id = "terminal-app-keyboard";
  panel.className = "terminal-app-keyboard";
  panel.setAttribute("aria-label", "App Keyboard");
  panel.hidden = true;
  const toolbar = document.createElement("div");
  toolbar.className = "app-keyboard-toolbar";
  const layouts = document.createElement("div");
  layouts.className = "app-keyboard-layouts";
  layouts.setAttribute("role", "group");
  layouts.setAttribute("aria-label", "Keyboard layout");
  const mac = makeButton("Mac", "app-keyboard-layout");
  const windows = makeButton("Windows", "app-keyboard-layout");
  layouts.append(mac, windows);
  const symbols = makeButton("123 / #+=", "app-keyboard-symbols");
  symbols.setAttribute("aria-label", "Show numbers and symbols");
  symbols.setAttribute("aria-pressed", "false");
  symbols.setAttribute("aria-controls", "app-keyboard-compact");
  const close = makeButton("Hide", "app-keyboard-close");
  close.setAttribute("aria-label", "Hide App Keyboard");
  toolbar.append(layouts, symbols, close);
  const keys = document.createElement("div");
  keys.className = "app-keyboard-keys";
  const hint = document.createElement("p");
  hint.className = "app-keyboard-hint";
  hint.textContent = "Keys type directly in terminal · tap a modifier, then a key. Option/Alt and Command/Win send Meta.";
  panel.append(toolbar, keys, hint);
  const keyButtons: Array<{ button: HTMLButtonElement; key: string; modifier?: keyof KeyboardModifiers }> = [];
  const updateKeys = (): void => {
    modifiers.shift = options.shift.active;
    for (const item of keyButtons) {
      if (item.modifier) item.button.setAttribute("aria-pressed", String(modifiers[item.modifier]));
      else if (item.key.length === 1) {
        item.button.textContent = keyboardCharacter(item.key, modifiers);
        item.button.setAttribute("aria-label", item.button.textContent);
      }
    }
  };
  const resetModifiers = (): void => {
    modifiers.ctrl = modifiers.alt = modifiers.meta = modifiers.caps = false;
    updateKeys();
  };
  const unsubscribeShift = options.shift.subscribe(updateKeys);
  const renderKeys = (): void => {
    cancelRepeat();
    keys.replaceChildren();
    keyButtons.length = 0;
    mac.setAttribute("aria-pressed", String(layout === "mac"));
    windows.setAttribute("aria-pressed", String(layout === "windows"));
    const rows = [
      ["Escape", ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)],
      [..."`1234567890-=", "Backspace"],
      ["Tab", ..."qwertyuiop[]\\"],
      ["caps", ..."asdfghjkl;'", "Enter"],
      ["shift", ..."zxcvbnm,./", "ArrowUp"],
      layout === "mac" ? ["ctrl", "alt", "meta", "Space", "ArrowLeft", "ArrowDown", "ArrowRight"]
        : ["ctrl", "meta", "alt", "Space", "ArrowLeft", "ArrowDown", "ArrowRight"],
      ["Home", "End", "Insert", "Delete", "PageUp", "PageDown"],
    ];
    const labels: Record<string, string> = {
      Escape: "Esc", Backspace: "⌫", Enter: layout === "mac" ? "Return" : "Enter", caps: "Caps", shift: "Shift",
      ctrl: "Ctrl", alt: layout === "mac" ? "⌥ Option" : "Alt", meta: layout === "mac" ? "⌘ Cmd" : "Win",
      Space: "Space", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", PageUp: "PgUp", PageDown: "PgDn",
    };
    const names: Record<string, string> = { caps: "Caps Lock", shift: "Shift", ctrl: "Control", alt: layout === "mac" ? "Option" : "Alt", meta: layout === "mac" ? "Command" : "Windows" };
    const full = document.createElement("div");
    full.className = "app-keyboard-full";
    const compact = document.createElement("div");
    compact.className = "app-keyboard-compact";
    compact.id = "app-keyboard-compact";
    const renderRow = (parent: HTMLElement, rowKeys: string[], className = ""): void => {
      const row = document.createElement("div");
      row.className = `app-keyboard-row ${className}`;
      for (const key of rowKeys) {
        const keyButton = makeButton(labels[key] ?? key, "app-keyboard-key terminal-control-key");
        if (parent === compact && layout === "mac" && key === "alt") keyButton.textContent = "⌥";
        if (parent === compact && layout === "mac" && key === "meta") keyButton.textContent = "⌘";
        if (parent === compact && key === "Enter") keyButton.textContent = "↵";
        keyButton.disabled = !connected;
        keyButton.dataset.key = key;
        keyButton.setAttribute("aria-label", names[key] ?? (key === "Backspace" ? "Backspace" : labels[key] ?? key));
        if (key === "Space") keyButton.classList.add("app-keyboard-space");
        else if (key.length > 1) keyButton.classList.add("app-keyboard-wide");
        const modifier = Object.hasOwn(modifiers, key) ? key as keyof KeyboardModifiers : undefined;
        keyButtons.push({ button: keyButton, key, modifier });
        // Do not focus xterm's textarea: that would open the device keyboard.
        const pressKey = (): boolean => {
          if (!connected || disposed || keyButton.disabled) return false;
          if (modifier) {
            if (modifier === "shift") options.shift.toggle();
            else modifiers[modifier] = !modifiers[modifier];
          } else {
            let sent = false;
            try { sent = options.send(terminalKeyboardInput(key, modifiers, options.applicationCursor())); } catch { /* A transport can close before its close event arrives. */ }
            if (!sent) {
              options.status("Not sent · terminal is reconnecting");
              return false;
            }
            modifiers.ctrl = modifiers.alt = modifiers.meta = false;
            options.shift.set(false);
          }
          updateKeys();
          return true;
        };
        keyButton.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          if (key !== "Backspace") { cancelRepeat(); return; }
          if (!event.isPrimary || event.button !== 0 || heldKey || !connected) return;
          heldKey = { button: keyButton, pointerId: event.pointerId };
          try { keyButton.setPointerCapture(event.pointerId); } catch { /* Window listeners also handle release. */ }
          repeat.start(() => {
            if (!heldKey || !keyButton.isConnected || !keyButton.getClientRects().length || !pressKey()) {
              cancelRepeat();
              return false;
            }
            return true;
          });
        });
        keyButton.addEventListener("click", (event) => {
          // Pointer presses already sent their first deletion on pointerdown.
          // detail=0 preserves keyboard, assistive technology, and .click().
          if (key === "Backspace" && (event.detail > 0 || (event instanceof PointerEvent && !!event.pointerType))) return;
          cancelRepeat();
          pressKey();
        });
        if (key === "Backspace") {
          keyButton.addEventListener("contextmenu", (event) => event.preventDefault());
          keyButton.addEventListener("lostpointercapture", () => { if (heldKey?.button === keyButton) cancelRepeat(); });
        }
        row.append(keyButton);
      }
      parent.append(row);
    };
    rows.forEach((rowKeys, rowIndex) => {
      renderRow(full, rowKeys, rowIndex === 0 || rowIndex === rows.length - 1 ? "app-keyboard-utility-row" : "");
    });
    renderRow(compact, ["Escape", "Tab", "ArrowLeft", "ArrowDown", "ArrowUp", "ArrowRight", "Home", "End", "Insert", "Delete", "PageUp", "PageDown", ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)], "app-keyboard-scroll-row");
    renderRow(compact, [..."qwertyuiop"], "app-keyboard-letters");
    renderRow(compact, ["caps", ..."asdfghjkl"], "app-keyboard-letters");
    renderRow(compact, ["shift", ..."zxcvbnm", "Backspace"], "app-keyboard-letters");
    renderRow(compact, [..."1234567890"], "app-keyboard-symbol-row");
    renderRow(compact, [..."-=[]\\;',./"], "app-keyboard-symbol-row");
    renderRow(compact, ["shift", ..."`!@#$%^&", "Backspace"], "app-keyboard-symbol-row");
    renderRow(compact, layout === "mac" ? ["ctrl", "alt", "meta", "Space", "Enter"] : ["ctrl", "meta", "alt", "Space", "Enter"]);
    keys.append(full, compact);
    updateKeys();
  };
  symbols.addEventListener("click", () => {
    cancelRepeat();
    const showingSymbols = keys.classList.toggle("app-keyboard-show-symbols");
    symbols.textContent = showingSymbols ? "ABC" : "123 / #+=";
    symbols.setAttribute("aria-label", showingSymbols ? "Show letters" : "Show numbers and symbols");
    symbols.setAttribute("aria-pressed", String(showingSymbols));
    options.resize();
  });
  for (const [choice, value] of [[mac, "mac"], [windows, "windows"]] as const) {
    choice.addEventListener("click", () => {
      layout = value;
      resetModifiers();
      try { localStorage.setItem("termlinks-app-keyboard-layout", layout); } catch { /* Keep this selection for the current view. */ }
      renderKeys();
      options.resize();
    });
  }
  const setOpen = (open: boolean): void => {
    cancelRepeat();
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    panel.closest(".terminal-composer")?.classList.toggle("app-keyboard-open", open);
    resetModifiers();
    if (open && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (!open) button.focus({ preventScroll: true });
    options.resize();
  };
  button.addEventListener("click", () => setOpen(panel.hidden));
  close.addEventListener("click", () => setOpen(false));
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  });
  const onPointerEnd = (event: PointerEvent): void => {
    if (heldKey?.pointerId === event.pointerId) cancelRepeat();
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (heldKey?.pointerId !== event.pointerId) return;
    const bounds = heldKey.button.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) cancelRepeat();
  };
  const onVisibility = (): void => { if (document.hidden) cancelRepeat(); };
  window.addEventListener("pointerup", onPointerEnd, true);
  window.addEventListener("pointercancel", onPointerEnd, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("blur", cancelRepeat);
  document.addEventListener("visibilitychange", onVisibility);
  const resizeObserver = new ResizeObserver(cancelRepeat);
  resizeObserver.observe(panel);
  renderKeys();
  return {
    button, panel,
    reset: (): void => { cancelRepeat(); options.shift.set(false); resetModifiers(); },
    setConnected: (value: boolean): void => {
      connected = value;
      if (!value) { cancelRepeat(); options.shift.set(false); resetModifiers(); }
      for (const item of keyButtons) item.button.disabled = !value;
    },
    dispose: (): void => {
      disposed = true;
      cancelRepeat();
      unsubscribeShift();
      resizeObserver.disconnect();
      window.removeEventListener("pointerup", onPointerEnd, { capture: true });
      window.removeEventListener("pointercancel", onPointerEnd, { capture: true });
      window.removeEventListener("pointermove", onPointerMove, { capture: true });
      window.removeEventListener("blur", cancelRepeat);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
