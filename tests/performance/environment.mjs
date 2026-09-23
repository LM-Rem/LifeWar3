import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
function command(exe, args) {
  try { return execFileSync(exe, args, { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return null; }
}
export function environment() {
  return { capturedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    os: os.release(), arch: process.arch, cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length,
    memoryBytes: os.totalmem(), gpu: command('nvidia-smi', ['--query-gpu=name,driver_version,memory.total,temperature.gpu,clocks.current.graphics', '--format=csv,noheader']),
    powerSchemeGuid: process.platform === 'win32' ? command('powercfg', ['/getactivescheme'])?.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0] ?? null : null,
    browser: null, dpr: null, displayRefreshHz: null, measuredNetworkMbps: null,
    unavailable: 'null means unmeasured; CPU synthetic runs do not measure browser, display or network.' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(environment(), null, 2));
