import { Worker } from 'node:worker_threads';
import { ruleMask } from './rule-table.js';
import { gpuProbe } from './gpu-probe.js';

// Some drivers initialize cleanly, report a real hardware adapter, and then take
// the whole Node process down with a native fault (0xC0000005, no JS error, no
// server 'close') on the first compute dispatch. Nothing in-process can catch
// that, so the only safe defence is refusing the adapter up front. Set
// LIFEWAR_GPU_ALLOW_UNSAFE=1 to try these anyway; known cases:
// Intel Gen 6-9.5 (HD/UHD 5xx-6xx) on legacy D3D12 drivers.
function unsafeAdapter(adapter) {
  if (process.env.LIFEWAR_GPU_ALLOW_UNSAFE === '1') return null;
  const vendor = String(adapter?.vendor ?? '').toLowerCase();
  const architecture = String(adapter?.architecture ?? '').toLowerCase();
  if (!vendor.includes('intel') || !/^gen-(6|7|7\.5|8|9|9\.5)$/.test(architecture)) return null;
  const description = String(adapter?.description ?? '旧版驱动');
  return `已拒绝在该显卡上启用 WebGPU：${vendor} ${architecture}（${description}）。此驱动会在首次计算时直接崩溃整个进程，现已改用 CPU 后端，规则和玩法不受影响。若确实要强制启用，请设置 LIFEWAR_GPU_ALLOW_UNSAFE=1（进程仍会崩溃）。`;
}

// Synchronous, bounded bridge preserves Game.step's atomic command boundary.
// This is experimental: readback + candidate/settlement CPU cost is measured too.
export async function createGpuEvolution({ size = 1000, timeoutMs = 100, startupTimeoutMs = 15000 } = {}) {
  const probe = gpuProbe(size);
  if (process.env.LIFEWAR_GPU_ALLOW_UNSAFE !== '1' && process.env.LIFEWAR_GPU_PROBE !== '0' && probe.crashed())
    throw new Error(`WebGPU 已停用：上一次 GPU 初始化或首次计算未完成，可能是驱动崩溃，也可能是在探测期间关闭了窗口。为避免反复启动崩溃，在删除标记文件前使用 CPU 后端，规则和玩法不受影响。\n  标记文件：${probe.file}\n  清除方法：删除项目根目录下的 gpu-probe.json（或在 PowerShell 执行 Remove-Item "${probe.file}"），然后重启服务器即可重新尝试 GPU。\n  其它开关：设置 LIFEWAR_GPU_PROBE=0 可忽略该标记，设置 LIFEWAR_GPU_ALLOW_UNSAFE=1 可强制启用 GPU（仍可能崩溃）。`);
  const control = new Int32Array(new SharedArrayBuffer(4));
  const input = new Uint32Array(new SharedArrayBuffer(size * size * 4));
  const output = new Uint32Array(new SharedArrayBuffer(input.byteLength));
  probe.arm();
  let worker;
  try {
    worker = new Worker(new URL('./gpu-worker.js', import.meta.url), { execArgv: [], workerData: { control: control.buffer, input: input.buffer, output: output.buffer } });
  } catch (error) { probe.release(); throw error; }
  let healthy = true, reason = null, exited = false, proved = false;
  let closePromise;
  worker.once('exit', () => { exited = true; healthy = false; });
  const close = () => {
    healthy = false;
    probe.release();
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
  const unsafe = unsafeAdapter(adapter);
  if (unsafe) { await close(); throw new Error(unsafe); }
  worker.unref();
  return {
    adapter,
    get healthy() { return healthy; },
    get reason() { return reason; },
    compute(game, rules) {
      if (!healthy || game.size !== size || game.localRules.length > 64) return null;
      if (game.localRules.some(r => ![r.x,r.y,r.radius].every(v => Number.isInteger(v) && v >= 0 && v <= 10000))) return null;
      input.set(game.board); Atomics.store(control, 0, 0);
      worker.postMessage({ size, generation: game.generation, ...rules,
        localRules: game.localRules.map(r => [r.x,r.y,r.radius,ruleMask(r.birth),ruleMask(r.survival),0,0,0]) });
      Atomics.wait(control, 0, 0, timeoutMs);
      if (Atomics.load(control, 0) !== 1) { Atomics.store(control, 0, -2); disable('GPU failed or timed out; CPU fallback'); return null; }
      if (!proved) { proved = true; probe.release(); }
      return output;
    },
    close
  };
}
