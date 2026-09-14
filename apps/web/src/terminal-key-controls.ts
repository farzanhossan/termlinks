export class TerminalShift {
  active = false;
  private readonly listeners = new Set<() => void>();

  set(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    for (const listener of this.listeners) listener();
  }

  toggle(): void { this.set(!this.active); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => { this.listeners.delete(listener); };
  }
}

export type RepeatClock = { set(callback: () => void, delay: number): number; clear(id: number): void };

export class TerminalKeyRepeat {
  private timer?: number;
  private generation = 0;
  private held = false;

  constructor(private readonly clock: RepeatClock) {}

  start(press: () => boolean): void {
    if (this.held) return;
    this.held = true;
    const generation = ++this.generation;
    const step = (delay: number): void => {
      if (!this.held || generation !== this.generation) return;
      if (!press()) { this.cancel(); return; }
      if (!this.held || generation !== this.generation) return;
      this.timer = this.clock.set(() => { this.timer = undefined; step(60); }, delay);
    };
    step(400);
  }

  cancel(): void {
    this.held = false;
    this.generation += 1;
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = undefined;
  }
}
