// Core types for reactivity system

/**
 * Represents the internal state of a signal
 * Contains the current value and keeps track of observers (computations that depend on this signal)
 */
interface SignalState<T> {
  value: T; // Current value of the signal
  observers: Computation<any>[] | null; // List of computations that depend on this signal
  comparator?: (prev: T, next: T) => boolean; // Custom equality function to determine if value has changed
}

/**
 * Represents a reactive computation
 * Can be either an effect or a memo
 */
interface Computation<T> {
  fn: () => T; // Function to compute the value
  state: number; // Current state (STALE or CLEAN)
  sources: SignalState<any>[] | null; // Signals that this computation depends on
  value: T; // Current computed value
  observers: Computation<any>[] | null; // Other computations that depend on this one
  owner: Owner | null; // Parent computation/scope
  pure?: boolean; // If true, this is a memo computation that caches its value
}

/**
 * Represents a scope that owns computations
 * Used for proper cleanup and disposing of reactive computations
 */
interface Owner {
  owned: Computation<any>[] | null; // List of computations owned by this scope
  owner: Owner | null; // Parent owner
}

// Constants for computation states
const STALE = 1; // Indicates that computation needs to be updated
const CLEAN = 0; // Indicates that computation is up to date

// Global state for tracking reactivity
let Owner: Owner | null = null; // Current owner scope
let Listener: Computation<any> | null = null; // Currently running computation
let Updates: Computation<any>[] | null = null; // Queue of memo computations to update
let Effects: Computation<any>[] | null = null; // Queue of effects to run

/**
 * Creates a new signal with getter and setter
 *
 * @param initialValue The initial value of the signal
 * @param options Configuration options including custom equality function
 * @returns Tuple of getter and setter functions
 *
 * Example:
 * const [count, setCount] = createSignal(0);
 * count(); // reads the value
 * setCount(1); // updates the value
 */
export function createSignal<T>(
  initialValue: T,
  options?: { equals?: (prev: T, next: T) => boolean },
): [() => T, (v: T) => void] {
  // Create internal state for the signal
  const state: SignalState<T> = {
    value: initialValue,
    observers: null,
    comparator: options?.equals,
  };

  // Getter function that tracks dependencies
  const read = () => {
    // If there's a current computation running, track this signal as a dependency
    if (Listener) {
      trackSignal(state);
    }
    return state.value;
  };

  // Setter function that updates value and notifies observers
  const write = (nextValue: T) => {
    // Only update if value actually changed (using custom comparator if provided)
    if (!state.comparator || !state.comparator(state.value, nextValue)) {
      state.value = nextValue;
      notifyObservers(state);
    }
  };

  return [read, write];
}

/**
 * Creates a derived signal (memo) that automatically updates when its dependencies change
 *
 * @param fn Computation function that derives new value
 * @param options Configuration options including custom equality function
 * @returns Getter function for the derived value
 *
 * Example:
 * const doubled = createMemo(() => count() * 2);
 */
export function createMemo<T>(
  fn: () => T,
  options?: { equals?: (prev: T, next: T) => boolean },
): () => T {
  // Create a pure computation for the memo
  const computation = createComputation(fn, true);

  // Create state to track memo value
  const state: SignalState<T> = {
    value: computation.value,
    observers: null,
    comparator: options?.equals,
  };

  // Getter function that ensures value is up to date
  const read = () => {
    if (Listener) {
      trackSignal(state);
    }

    // Update value if computation is stale
    if (computation.state === STALE) {
      updateComputation(computation);
      // Only notify observers if value actually changed
      if (
        !state.comparator ||
        !state.comparator(state.value, computation.value)
      ) {
        state.value = computation.value;
        notifyObservers(state);
      }
    }

    return state.value;
  };

  // Initial computation
  read();

  return read;
}

/**
 * Creates a new computation
 * Internal function used by createMemo and createEffect
 */
function createComputation<T>(
  fn: () => T,
  pure: boolean = false,
): Computation<T> {
  const computation: Computation<T> = {
    fn,
    state: STALE,
    sources: null,
    value: undefined as T,
    observers: null,
    owner: Owner,
    pure,
  };

  // Register computation with current owner if exists
  if (Owner) {
    if (!Owner.owned) Owner.owned = [computation];
    else Owner.owned.push(computation);
  }

  updateComputation(computation);
  return computation;
}

/**
 * Creates an effect that runs when its dependencies change
 *
 * @param fn Effect function to run
 *
 * Example:
 * createEffect(() => console.log("Count is:", count()));
 */
export function createEffect(fn: () => void): void {
  const computation = createComputation(fn);
  if (!Effects) Effects = [];
  Effects.push(computation);
}

/**
 * Tracks a signal as a dependency of the current computation
 * Sets up the observer-observable relationship
 */
function trackSignal(signal: SignalState<any>) {
  // Add signal as a source to current computation
  if (!Listener!.sources) {
    Listener!.sources = [signal];
  } else {
    Listener!.sources.push(signal);
  }

  // Add current computation as observer of signal
  if (!signal.observers) {
    signal.observers = [Listener!];
  } else {
    signal.observers.push(Listener!);
  }
}

/**
 * Cleans up dependencies of a computation
 * Removes computation from observers lists of its sources
 */
function cleanupComputation(computation: Computation<any>) {
  if (computation.sources) {
    for (const source of computation.sources) {
      const index = source.observers?.indexOf(computation);
      if (index !== undefined && index > -1) {
        source.observers?.splice(index, 1);
      }
    }
    computation.sources = null;
  }
}

/**
 * Updates a computation by running its function and tracking dependencies
 */
function updateComputation(computation: Computation<any>) {
  const prevListener = Listener;
  Listener = computation;

  // Clean up old dependencies before running
  cleanupComputation(computation);

  try {
    computation.value = computation.fn();
    computation.state = CLEAN;
  } finally {
    Listener = prevListener;
  }
}

/**
 * Notifies all observers of a signal that it has changed
 * Queues updates for affected computations
 */
function notifyObservers(signal: SignalState<any>) {
  if (!signal.observers) return;

  for (const observer of signal.observers) {
    if (observer.state !== STALE) {
      observer.state = STALE;
      // Queue pure computations (memos) in Updates
      if (observer.pure) {
        if (!Updates) Updates = [];
        Updates.push(observer);
      }
      // Queue effects in Effects
      else {
        if (!Effects) Effects = [];
        Effects.push(observer);
      }
    }
  }

  runUpdates();
}

/**
 * Processes queued updates and effects
 * Ensures proper order of updates: memos before effects
 */
function runUpdates() {
  // Run memo updates first
  if (Updates) {
    const computations = Updates;
    Updates = null;
    for (const computation of computations) {
      if (computation.state === STALE) {
        updateComputation(computation);
      }
    }
  }

  // Run effects after all memos are updated
  if (Effects) {
    const effects = Effects;
    Effects = null;
    for (const effect of effects) {
      if (effect.state === STALE) {
        updateComputation(effect);
      }
    }
  }
}

/**
 * Executes a function without tracking dependencies
 * Useful for reading signals without creating dependencies
 */
export function untrack<T>(fn: () => T): T {
  const prevListener = Listener;
  Listener = null;
  try {
    return fn();
  } finally {
    Listener = prevListener;
  }
}
