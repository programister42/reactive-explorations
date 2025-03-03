/* reactive-explorations/index.ts */

type RunningContext = {
  execute: () => void;
  dependencies: Set<Set<RunningContext>>;
};

// We store a stack of running contexts (the currently "active" effect).
const context: RunningContext[] = [];

function subscribe(
  running: RunningContext,
  subscriptions: Set<RunningContext>,
): void {
  subscriptions.add(running);
  running.dependencies.add(subscriptions);
}

/**
 * Creates a reactive signal.
 *
 * @param value - the initial value for the signal
 * @returns a tuple of [getter, setter]
 */
export function createSignal<T>(value: T): [() => T, (nextValue: T) => void] {
  const subscriptions = new Set<RunningContext>();

  const read = (): T => {
    // The most recently pushed effect is the one currently running.
    const running = context[context.length - 1];
    if (running) {
      subscribe(running, subscriptions);
    }
    return value;
  };

  const write = (nextValue: T): void => {
    value = nextValue;
    // Call .execute() on subscribers so they re-run
    for (const sub of [...subscriptions]) {
      sub.execute();
    }
  };

  return [read, write];
}

function cleanup(running: RunningContext): void {
  // Remove this running context from all dependencies it subscribed to
  for (const dep of running.dependencies) {
    dep.delete(running);
  }
  running.dependencies.clear();
}

/**
 * Creates a reactive effect, which runs whenever any signal that it
 * reads/watches changes.
 *
 * @param fn - a function to run reactively
 */
export function createEffect(fn: () => void): void {
  const running: RunningContext = {
    execute: () => {
      cleanup(running);
      context.push(running);
      try {
        fn();
      } finally {
        context.pop();
      }
    },
    dependencies: new Set(),
  };

  // Run effect immediately once at creation time
  running.execute();
}

/**
 * Creates a memoized (cached) value that automatically updates
 * whenever the signals it reads are updated.
 *
 * @param fn - a function whose return value is cached
 * @returns a getter for the memoized value
 */
export function createMemo<T>(fn: () => T): () => T {
  // Create a signal but temporarily store it with an unsafe "undefined" as T
  const [s, set] = createSignal<T>(undefined as unknown as T);
  createEffect(() => set(fn()));
  return s;
}
