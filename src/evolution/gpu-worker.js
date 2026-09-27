import { parentPort, workerData } from 'node:worker_threads';

const control = new Int32Array(workerData.control);
const input = new Uint32Array(workerData.input), output = new Uint32Array(workerData.output);
let device, gpu, closing = false, busy = false, closeRequested = false;
const fail = error => {
  if (closing) return;
  Atomics.store(control, 0, -1); Atomics.notify(control, 0);
  parentPort.postMessage({ error: String(error?.message ?? error) });
};
try {
  const { create, globals } = await import('webgpu');
  Object.assign(globalThis, globals);
  gpu = create([]); // Keep Dawn alive for the worker lifetime.
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter || adapter.info.isFallbackAdapter) throw new Error('No hardware WebGPU adapter');
  device = await adapter.requestDevice();
  device.lost.then(info => fail(info.message));
  device.addEventListener('uncapturederror', event => fail(event.error));
  const bytes = input.byteLength;
  const source = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const target = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const localRules = device.createBuffer({ size: 64 * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const shader = device.createShaderModule({ code: `
struct Params { size: u32, generation: u32, birth: u32, survival: u32, priority: u32, localCount: u32 }
struct LocalRule { x: u32, y: u32, radius: u32, birth: u32, survival: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> board: array<u32>;
@group(0) @binding(1) var<storage, read_write> next: array<u32>;
@group(0) @binding(2) var<uniform> p: Params;
@group(0) @binding(3) var<storage, read> locals: array<LocalRule>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let key = gid.x;
  if (key >= p.size * p.size) { return; }
  let x = i32(key % p.size); let y = i32(key / p.size);
  var count = 0u; var votes: array<u32, 5>;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let xx = x + dx; let yy = y + dy;
      if ((dx == 0 && dy == 0) || xx < 0 || yy < 0 || xx >= i32(p.size) || yy >= i32(p.size)) { continue; }
      let owner = board[u32(yy) * p.size + u32(xx)];
      if (owner > 0u) { count++; votes[owner]++; }
    }
  }
  var owner = board[key];
  var mask = select(p.birth, p.survival, owner > 0u);
  for (var i = p.localCount; i > 0u; i--) {
    let rule = locals[i - 1u];
    let dx = x - i32(rule.x); let dy = y - i32(rule.y);
    if (dx * dx + dy * dy <= i32(rule.radius * rule.radius)) {
      mask = select(rule.birth, rule.survival, owner > 0u); break;
    }
  }
  if ((mask & (1u << count)) == 0u) { next[key] = 0u; return; }
  if (owner == 0u) {
    var best = 0u;
    for (var t = 0u; t < 4u; t++) {
      let team = ((t + key + p.generation) % 4u) + 1u;
      if (votes[team] > best) { best = votes[team]; owner = team; }
    }
    if (p.priority > 0u && votes[p.priority] > 0u) { owner = p.priority; }
  }
  next[key] = owner;
}` });
  const diagnostics = await shader.getCompilationInfo();
  const errors = diagnostics.messages.filter(m => m.type === 'error');
  if (errors.length) throw new Error(errors.map(m => m.message).join('\n'));
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: shader, entryPoint: 'main' } });
  const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [source, target, params, localRules].map((buffer, binding) => ({ binding, resource: { buffer } })) });
  const info = adapter.info;
  parentPort.postMessage({ ready: true, adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } });
  const close = () => {
    closing = true;
    source.destroy(); target.destroy(); readback.destroy(); params.destroy(); localRules.destroy();
    device.destroy(); device = null; gpu = null;
    parentPort.removeAllListeners('message'); parentPort.close();
  };
  parentPort.on('message', async job => {
    if (job.close) {
      closeRequested = true;
      if (!busy) close();
      return;
    }
    busy = true;
    try {
      device.queue.writeBuffer(source, 0, input);
      device.queue.writeBuffer(params, 0, new Uint32Array([job.size, job.generation, job.birthMask, job.survivalMask, job.priorityOwner, job.localRules.length, 0, 0]));
      if (job.localRules.length) device.queue.writeBuffer(localRules, 0, new Uint32Array(job.localRules.flat()));
      const commands = device.createCommandEncoder();
      const pass = commands.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(Math.ceil(job.size * job.size / 256)); pass.end();
      commands.copyBufferToBuffer(target, 0, readback, 0, bytes);
      device.queue.submit([commands.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      output.set(new Uint32Array(readback.getMappedRange())); readback.unmap();
      // A timeout permanently abandons this worker; never publish late results.
      Atomics.compareExchange(control, 0, 0, 1); Atomics.notify(control, 0);
    } catch (error) { fail(error); }
    finally { busy = false; if (closeRequested) close(); }
  });
} catch (error) { fail(error); closing = true; device?.destroy(); device = null; gpu = null; parentPort.close(); }
