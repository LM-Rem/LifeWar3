import { gpuProbe } from '../../src/evolution/gpu-probe.js';
const probe = gpuProbe(20, { file: process.argv[2], enabled: true });
probe.arm();
if (process.argv[3] === 'success') probe.release();
process.on('message', () => {});
process.send({ ready: true });
