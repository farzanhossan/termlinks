# Mobile terminal interaction verification

## 2026-09-15: App Keyboard display and connection recovery

- Automated regressions run the production input, encrypted bridge, heartbeat,
  and terminal reconnect functions. They cover offscreen prompt updates with
  real xterm, failed sends, one outstanding heartbeat, stale callbacks, snapshot
  timeouts, increasing retry delays, and cleanup after failed restoration.
- Isolated headless Chrome verification used the responsive 390px keyboard,
  real xterm and mobile scroll handlers, synthetic touch pointer events, and
  simulated terminal output. Tapping Backspace then typing, holding/releasing
  Backspace, deleting wrapped lines, alternate-screen input, and hiding/reopening
  the keyboard all kept the expected text visible without duplicate input.
- Browser verification used normal timing. Chrome's virtual-time run did not
  repaint reliably in this macOS environment and was not used as passing evidence.
- Frontend tests, typecheck, production web build, and `git diff --check` passed.
- Physical Android Chrome/PWA and the deployed encrypted portal remain unverified.
  Repeat the same gestures in a shell, Claude Code, and Codex, then switch apps
  and interrupt/restore the network. Confirm the same session returns, output
  catches up, and uncertain keystrokes are not replayed. Network outages may still
  produce a reconnect indicator; recovery must not stay stuck after service returns.

## 2026-09-05/06: Earlier mobile interaction checks

Local verification on 2026-09-05/06 used Chrome through browser automation,
a 390×844 viewport, the actual responsive terminal handler, an isolated
Termlinks daemon, and real persistent Zsh and Claude sessions.

## Verified

- Created a shell through the website; it stayed headless.
- Pasted `printf 'PASTE_UAT_OK\n'` with the native clipboard shortcut in
  Version 2. It remained pending until Enter, printed the marker once, and
  returned to the same shell prompt.
- Generated 150 numbered history lines through the terminal. Native drag
  selection returned two exact rendered lines. Scrolling then moved from
  the latest lines into older history with terminal content still visible.
- Inspected the Version 2 input target: full cursor-row width, opaque
  editable element with transparent text, 16px font, and no dependency on
  the focus class. Historical rows no longer have an editable overlay when
  the live cursor is outside the viewport.
- Started a real Claude session and pasted a harmless request for 80
  numbered lines. Explicit Enter submitted it. Scrolling moved backward
  and forward through Claude's alternate-screen history.
- After the resize-reset fix, scrolling also worked while terminal input
  retained focus. Typed `INPUT_STILL_WORKS` after scrolling and confirmed
  it appeared at Claude's prompt; cleared it without submitting.
- Browser error log was empty. Full `npm test`, production build, and
  `git diff --check` passed. Stopped only the two disposable test sessions.

## Still requires a physical iPhone

Desktop viewport testing does not emulate iOS's native long-press menu,
selection handles, software keyboard animation, or finger inertia. Verify
in the installed PWA: hold the cursor row before and after opening the
keyboard, choose Paste, press Enter separately, drag output selection
handles, scroll both directions, and repeat after switching apps.

Selection spanning beyond the currently rendered xterm viewport and
selection during live TUI redraws have not been verified by this run.
Do not describe this evidence as complete iOS UAT or a guarantee of
flawless behavior on all terminals.
