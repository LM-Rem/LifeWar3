import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PROBE_FILE = fileURLToPath(new URL('../../gpu-probe.json', import.meta.url));
const processAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// This guards initialization and the FIRST compute dispatch only. A leftover
// session marker cannot distinguish closing a console from a native GPU fault.
// Once compute succeeds, release it rather than arming it for the whole game.
export function gpuProbe(size, { file = PROBE_FILE, enabled = process.env.LIFEWAR_GPU_PROBE !== '0' } = {}) {
  const id = randomUUID();
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
  const write = probe => { try { writeFileSync(file, JSON.stringify(probe, null, 2)); } catch {} };
  const remove = () => { try { rmSync(file, { force: true }); } catch {} };
  const ownersOf = probe => Array.isArray(probe?.owners) ? probe.owners : [];
  return {
    file,
    crashed() {
      if (!enabled) return false;
      const probe = read();
      if (!probe || ownersOf(probe).some(o => processAlive(o.pid))) return false;
      // Older versions kept a 'stable' marker after successful computation.
      // It proves that startup worked, not that GPU caused the eventual exit.
      if (probe.phase === 'stable') { remove(); return false; }
      return probe.phase === 'armed';
    },
    arm() {
      if (!enabled) return;
      const probe = read() ?? {};
      const owners = ownersOf(probe).filter(o => o.id !== id && processAlive(o.pid));
      owners.push({ pid: process.pid, id, size });
      write({ ...probe, owners, phase: 'armed', at: Date.now() });
    },
    release() {
      if (!enabled) return;
      const probe = read();
      if (!ownersOf(probe).some(o => o.id === id)) return;
      const owners = ownersOf(probe).filter(o => o.id !== id);
      if (owners.length) return write({ ...probe, owners, at: Date.now() });
      remove();
    },
  };
}
