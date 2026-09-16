/** Resolve once and detach the abort listener on completion or UI disposal. */
export function dialogCompletion<T>(signal: AbortSignal | undefined, resolve: (value: T) => void, cancelled: T): {
  done: (value: T) => void;
  dispose: () => void;
} {
  let finished = false;
  const dispose = () => signal?.removeEventListener("abort", abort);
  const done = (value: T) => {
    if (finished) return;
    finished = true;
    dispose();
    resolve(value);
  };
  const abort = () => done(cancelled);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return { done, dispose };
}
