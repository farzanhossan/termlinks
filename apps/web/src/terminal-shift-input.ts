import { keyboardCharacter, terminalKeyboardInput, type KeyboardModifiers } from "./terminal-keyboard";
import type { TerminalShift } from "./terminal-key-controls";

const shifted: KeyboardModifiers = { shift: true, ctrl: false, alt: false, meta: false, caps: false };

export function shiftFirstCharacter(text: string): string {
  const first = Array.from(text)[0];
  return first ? keyboardCharacter(first, shifted) + text.slice(first.length) : text;
}

export function shiftedPhysicalInput(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey" | "getModifierState">, applicationCursor = false): string | undefined {
  const key = event.key === " " ? "Space" : event.key;
  if (key.length !== 1 && !/^(Space|Enter|Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Up|Down|Left|Right)|F([1-9]|1[0-2]))$/.test(key)) return undefined;
  const caps = event.getModifierState("CapsLock");
  // A physical Shift has already selected its printable character. Preserve it.
  if (key.length === 1 && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) return key;
  const base = key.length === 1 && /^[A-Z]$/.test(key) ? key.toLowerCase() : key;
  return terminalKeyboardInput(base, { shift: true, caps, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey }, applicationCursor);
}

export function installTerminalShiftInput(options: {
  root: HTMLElement;
  shift: TerminalShift;
  connected: () => boolean;
  send: (data: string) => boolean;
  applicationCursor: () => boolean;
}) {
  let composing = false;
  let compositionPending = false;
  let composerSnapshot: { input: HTMLTextAreaElement; value: string; start: number; end: number } | undefined;
  let compositionTimer: number | undefined;
  const targetInput = (event: Event): HTMLTextAreaElement | undefined => {
    const target = event.target;
    return target instanceof HTMLTextAreaElement && (target.classList.contains("terminal-composer-input") || target.classList.contains("xterm-helper-textarea")) ? target : undefined;
  };
  const isComposer = (input: HTMLTextAreaElement): boolean => input.classList.contains("terminal-composer-input");
  const consume = (): void => options.shift.set(false);
  const stop = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation(); };
  const insert = (input: HTMLTextAreaElement, text: string): void => {
    input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
    consume();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const send = (text: string): boolean => {
    try { if (!options.send(text)) return false; } catch { return false; }
    consume();
    return true;
  };
  const deleteText = (input: HTMLTextAreaElement, backwards: boolean): void => {
    let start = input.selectionStart;
    let end = input.selectionEnd;
    if (start === end) {
      if (backwards) start -= Array.from(input.value.slice(0, start)).at(-1)?.length ?? 0;
      else end += Array.from(input.value.slice(end))[0]?.length ?? 0;
    }
    input.setSelectionRange(start, end);
    insert(input, "");
  };
  const selectText = (input: HTMLTextAreaElement, key: string): boolean => {
    const forward = input.selectionDirection !== "backward";
    const anchor = forward ? input.selectionStart : input.selectionEnd;
    const caret = forward ? input.selectionEnd : input.selectionStart;
    const text = input.value;
    const lineStart = caret === 0 ? 0 : text.lastIndexOf("\n", caret - 1) + 1;
    const lineEndIndex = text.indexOf("\n", caret);
    const lineEnd = lineEndIndex < 0 ? text.length : lineEndIndex;
    let next = caret;
    if (key === "ArrowLeft") next -= Array.from(text.slice(0, caret)).at(-1)?.length ?? 0;
    else if (key === "ArrowRight") next += Array.from(text.slice(caret))[0]?.length ?? 0;
    else if (key === "Home") next = lineStart;
    else if (key === "End") next = lineEnd;
    else if (key === "ArrowUp") {
      const previousStart = lineStart < 2 ? 0 : text.lastIndexOf("\n", lineStart - 2) + 1;
      next = lineStart === 0 ? 0 : Math.min(lineStart - 1, previousStart + caret - lineStart);
    } else if (key === "ArrowDown") {
      const followingEnd = text.indexOf("\n", lineEnd + 1);
      next = lineEnd === text.length ? text.length : Math.min(followingEnd < 0 ? text.length : followingEnd, lineEnd + 1 + caret - lineStart);
    } else return false;
    input.setSelectionRange(Math.min(anchor, next), Math.max(anchor, next), next < anchor ? "backward" : "forward");
    consume();
    return true;
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const input = targetInput(event);
    if (!input || !options.shift.active || !options.connected() || composing || event.isComposing || event.keyCode === 229) return;
    // Native clipboard shortcuts must retain their default browser behavior.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    if (isComposer(input)) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Enter") { stop(event); insert(input, "\n"); return; }
      if (event.key === "Backspace" || event.key === "Delete") { stop(event); deleteText(input, event.key === "Backspace"); return; }
      if (selectText(input, event.key)) { stop(event); return; }
      if (event.key.length === 1) {
        const data = shiftedPhysicalInput(event);
        if (data !== undefined) { stop(event); insert(input, data); }
      } else if (event.key === "Tab") {
        // Let the browser move focus backward, as for a physical Shift+Tab.
        // Terminal Tab shortcuts still go directly to the session.
        stop(event);
        const focusable = Array.from(options.root.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, input, select, [tabindex="0"]')).filter((item) => item.getClientRects().length > 0);
        const index = focusable.indexOf(input);
        focusable[(index - 1 + focusable.length) % focusable.length]?.focus({ preventScroll: true });
        consume();
      }
      return;
    }
    const data = shiftedPhysicalInput(event, options.applicationCursor());
    if (data !== undefined) { stop(event); send(data); }
  };
  const onBeforeInput = (event: InputEvent): void => {
    const input = targetInput(event);
    if (!input || !options.shift.active || !options.connected() || composing || compositionPending || event.isComposing || !event.cancelable) return;
    if (event.inputType === "insertText" && event.data) {
      const text = shiftFirstCharacter(event.data);
      if (isComposer(input)) { stop(event); insert(input, text); }
      else { stop(event); send(text); }
    } else if (/^insert(LineBreak|Paragraph)$/.test(event.inputType)) {
      if (isComposer(input)) { stop(event); insert(input, "\n"); }
      else { stop(event); send("\r"); }
    } else if (/^deleteContent(Backward|Forward)$/.test(event.inputType)) {
      const backwards = event.inputType === "deleteContentBackward";
      if (isComposer(input)) { stop(event); deleteText(input, backwards); }
      else { stop(event); send(terminalKeyboardInput(backwards ? "Backspace" : "Delete", shifted)); }
    }
  };
  const finishComposerComposition = (): void => {
    const snapshot = composerSnapshot;
    if (!snapshot) return;
    composerSnapshot = undefined;
    compositionPending = false;
    const { input, value, start, end } = snapshot;
    if (!options.shift.active || !options.connected()) return;
    const insertedLength = input.value.length - value.length + end - start;
    if (insertedLength <= 0) return;
    const committed = input.value.slice(start, start + insertedLength);
    input.setRangeText(shiftFirstCharacter(committed), start, start + insertedLength, "preserve");
    consume();
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const onInput = (event: Event): void => {
    if (!(event instanceof InputEvent)) return;
    const input = targetInput(event);
    if (!input || composing || event.isComposing || !options.shift.active || !options.connected()) return;
    if (compositionPending) {
      if (isComposer(input)) finishComposerComposition();
      return;
    }
    // Some mobile browsers emit non-cancelable beforeinput events.
    if (event.inputType !== "insertText" || !event.data) return;
    if (isComposer(input)) {
      const end = input.selectionStart;
      const start = end - event.data.length;
      if (start < 0) return;
      input.setRangeText(shiftFirstCharacter(event.data), start, end, "end");
      consume();
    } else { stop(event); send(shiftFirstCharacter(event.data)); }
  };
  const onCompositionStart = (event: CompositionEvent): void => {
    const input = targetInput(event);
    if (!input) return;
    composing = true;
    compositionPending = false;
    if (isComposer(input)) composerSnapshot = { input, value: input.value, start: input.selectionStart, end: input.selectionEnd };
  };
  const onCompositionEnd = (event: CompositionEvent): void => {
    if (!targetInput(event)) return;
    composing = false;
    compositionPending = !!event.data;
    if (!compositionPending) composerSnapshot = undefined;
    if (compositionTimer !== undefined) window.clearTimeout(compositionTimer);
    // xterm finalizes its composition after the browser updates the textarea.
    // Only its committed printable input may use the pending Shift below.
    compositionTimer = window.setTimeout(() => {
      compositionTimer = undefined;
      finishComposerComposition();
    }, 0);
  };
  const resetComposition = (): void => {
    composing = compositionPending = false;
    composerSnapshot = undefined;
    if (compositionTimer !== undefined) window.clearTimeout(compositionTimer);
    compositionTimer = undefined;
  };
  const onPaste = (): void => resetComposition();
  options.root.addEventListener("keydown", onKeyDown, true);
  options.root.addEventListener("beforeinput", onBeforeInput, true);
  options.root.addEventListener("input", onInput, true);
  options.root.addEventListener("compositionstart", onCompositionStart, true);
  options.root.addEventListener("compositionend", onCompositionEnd, true);
  options.root.addEventListener("paste", onPaste, true);
  return {
    handleCompositionData: (data: string): boolean => {
      if ((!composing && !compositionPending) || !options.shift.active || !/^[^\x00-\x1f\x7f]+$/u.test(data)) return false;
      compositionPending = false;
      send(shiftFirstCharacter(data));
      return true;
    },
    reset: resetComposition,
    dispose: (): void => {
      resetComposition();
      options.root.removeEventListener("keydown", onKeyDown, { capture: true });
      options.root.removeEventListener("beforeinput", onBeforeInput, { capture: true });
      options.root.removeEventListener("input", onInput, { capture: true });
      options.root.removeEventListener("compositionstart", onCompositionStart, { capture: true });
      options.root.removeEventListener("compositionend", onCompositionEnd, { capture: true });
      options.root.removeEventListener("paste", onPaste, { capture: true });
    },
  };
}
