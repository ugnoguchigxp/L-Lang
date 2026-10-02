// Host timing only. The Wasm view supplies the interval and stop decision.
export function createTimer(onTick, clock = {}) {
  const now = clock.now ?? (() => performance.now());
  const start = clock.start ?? ((fn, delay) => setTimeout(fn, delay));
  const stop = clock.stop ?? ((id) => clearTimeout(id));
  let handle,
    generation = 0,
    deadline = 0,
    interval = 0;
  function cancel(forget = false) {
    generation++;
    if (handle !== undefined) stop(handle);
    handle = undefined;
    if (forget) {
      deadline = 0;
      interval = 0;
    }
  }
  return {
    cancel,
    update(delay, reset = false) {
      cancel();
      if (!Number.isInteger(delay) || delay < 0 || delay > 60000)
        throw new Error("Invalid timer view");
      if (delay === 0) {
        deadline = 0;
        interval = 0;
        return;
      }
      if (reset || !deadline || interval !== delay) deadline = now() + delay;
      interval = delay;
      const current = generation;
      handle = start(
        () => {
          if (current === generation) onTick();
        },
        Math.max(0, deadline - now()),
      );
    },
  };
}
