// Every asynchronous authentication operation must still own its generation
// before it may change the application or persist a credential.
export class AuthGeneration {
  private value = 0;
  current(): number { return this.value; }
  invalidate(): number { return ++this.value; }
  owns(value: number): boolean { return value === this.value; }
  assert(value: number): void {
    if (!this.owns(value)) throw new Error("Sign-in was cancelled");
  }
}
