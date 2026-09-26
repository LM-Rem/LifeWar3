import { Worker } from 'node:worker_threads';

// Synchronous, bounded bridge preserves Game.step's atomic command boundary.
// This is experimental: readback + candidate/settlement CPU cost is measured too.
export async function createGpuEvolution({ size = 1000, timeoutMs = 100, startupTimeoutMs = 15000 } = {}) {
  const control = new Int32Array(new SharedArrayBuffer(4));
  const input = new Uint32Array(new SharedArrayBuffer(size * size * 4));
  const output = new Uint32Array(new SharedArrayBuffer(input.byteLength));
  const worker = new Worker(new URL('./gpu-worker.js', import.meta.url), { execArgv: [], workerData: { control: control.buffer, input: input.buffer, output: output.buffer } });
  let healthy = true, reason = null, exited = false;
  let closePromise;
  worker.once('exit', () => { exited = true; healthy = false; });
  const close = () => {
    healthy = false;
    if (exited) return Promise.resolve();
    return closePromise ??= new Promise(resolve => {
      // Terminating a worker inside native Dawn teardown can terminate Node too.
      // A hung device is abandoned, unreferenced, and never reused.
      const timer = setTimeout(() => { worker.unref(); resolve(); }, 2000);
      worker.once('exit', () => { clearTimeout(timer); resolve(); });
      worker.ref(); worker.postMessage({close:true});
    });
  };
  const disable = error => { reason = String(error?.message ?? error); void close(); };
  worker.on('error', disable);
  worker.on('message', message => { if (message.error) disable(message.error); });
  let adapter;
  try {
    adapter = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('GPU startup timed out')), startupTimeoutMs);
      worker.once('error', error => { clearTimeout(timer); reject(error); });
      worker.once('message', message => { clearTimeout(timer); message.ready ? resolve(message.adapter) : reject(new Error(message.error)); });
    });
  } catch (error) { disable(error); throw error; }
  worker.unref();
  return {
    adapter,
    get healthy() { return healthy; },
    get reason() { return reason; },
    compute(game, rules) {
      if (!healthy || game.size !== size || game.localIndex.active) return null;
      input.set(game.board); Atomics.store(control, 0, 0);
      worker.postMessage({ size, generation: game.generation, ...rules });
      Atomics.wait(control, 0, 0, timeoutMs);
      if (Atomics.load(control, 0) !== 1) { Atomics.store(control, 0, -2); disable('GPU failed or timed out; CPU fallback'); return null; }
      return output;
    },
    close
  };
}
