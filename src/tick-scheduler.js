// Absolute monotonic deadlines prevent timer quantization from accumulating.
// One callback is one simulation step; elapsed time is never converted to
// skipped generations. Severe overload rebases wall-clock debt explicitly.
export function scheduleTicks(callback, {
  periodMs, now = () => performance.now(), setTimer = setTimeout,
  clearTimer = clearTimeout, setSoon = setImmediate, clearSoon = clearImmediate, onTiming = null
} = {}) {
  if (!Number.isFinite(periodMs) || periodMs <= 0) throw new Error('Invalid tick period');
  let stopped = false, timer, immediate = false, deadline = now() + periodMs, previous = null;
  const arm = () => {
    if (stopped) return;
    const remaining = deadline - now();
    // Only already-due work uses an immediate. Future deadlines always sleep;
    // there is no polling/spinning to obtain finer timer resolution. Yielding
    // overdue work through another timeout adds avoidable OS timer delay.
    immediate = remaining <= 0;
    timer = immediate ? setSoon(wake) : setTimer(wake, Math.max(1, Math.ceil(remaining)));
  };
  function wake() {
    if (stopped) return;
    const start = now();
    if (start < deadline) { arm(); return; }
    const expected = deadline;
    callback();
    const end = now();
    deadline += periodMs;
    // At most one period of catch-up debt. A stall cannot create an unbounded
    // burst that monopolizes the event loop or floods presentation queues.
    const rebaseMs = end - deadline > periodMs ? end - deadline : 0;
    if (rebaseMs) deadline += rebaseMs;
    onTiming?.({ scheduledAt: expected, startedAt: start, intervalMs: previous === null ? null : start - previous,
      latenessMs: start - expected, workMs: end - start, rebaseMs });
    previous = start;
    arm();
  }
  arm();
  return { stop() { stopped = true; immediate ? clearSoon(timer) : clearTimer(timer); } };
}
