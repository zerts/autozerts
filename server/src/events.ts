/** In-process event bus feeding the SSE stream and notifications. */

export type RunnerEvent =
  | { type: "loop.updated"; loopId: string }
  | { type: "t3.availability"; available: boolean }
  | { type: "stats.updated" };

type Listener = (event: RunnerEvent) => void;

const listeners = new Set<Listener>();

export function onEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emit(event: RunnerEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // a broken SSE client must not affect others
    }
  }
}
