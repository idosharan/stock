export class CollectionBudget {
  private readonly deadline = Date.now() + 300_000;

  constructor(private readonly onTimeout: (label: string) => void) {}

  get expired(): boolean { return Date.now() >= this.deadline; }

  run<Value>(label: string, task: () => Promise<Value>, fallback: Value): Promise<Value> {
    const remaining = Math.min(30_000, this.deadline - Date.now());
    if (remaining <= 0) {
      this.onTimeout(label);
      return Promise.resolve(fallback);
    }
    const expires = Date.now() + remaining;
    return new Promise((resolveValue, reject) => {
      let settled = false;
      const timedOut = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.onTimeout(label);
        resolveValue(fallback);
      };
      const timer = setTimeout(timedOut, remaining);
      Promise.resolve().then(task).then(value => {
        if (settled) return;
        if (Date.now() >= expires) { timedOut(); return; }
        settled = true;
        clearTimeout(timer);
        resolveValue(value);
      }, error => {
        if (settled) return;
        if (Date.now() >= expires) { timedOut(); return; }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}