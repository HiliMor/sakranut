// Controls display updates only; it never starts or stops server collection.
export function createRefreshController({ load, intervalMs, isVisible, schedule = setInterval, cancel = clearInterval, onChange = () => {} }) {
  let paused = false, busy = false, generation = 0, queued = null, disposed = false;
  async function request(reason = 'manual') {
    const automatic = reason === 'automatic' || reason === 'resume';
    if (disposed || (automatic && (paused || !isVisible()))) return;
    if (busy) { if (reason !== 'automatic' && queued !== 'manual') queued = reason; return; }
    busy = true;
    const started = generation;
    onChange();
    try {
      await load({ canApply: () => !disposed && (!automatic || (!paused && started === generation)) });
    } finally {
      busy = false;
      onChange();
      if (queued && !disposed) { const next = queued; queued = null; await request(next); }
    }
  }
  const timer = schedule(() => request('automatic'), intervalMs);
  return {
    request,
    get paused() { return paused; },
    get busy() { return busy; },
    setPaused(value) {
      if (paused === value) return;
      paused = value;
      generation++;
      onChange();
      if (!paused) return request('resume');
    },
    dispose() { disposed = true; queued = false; cancel(timer); }
  };
}
