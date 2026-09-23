// Explicit, one-shot capture of the WORKING TREE, never of HEAD.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const target = path.join(root, 'tests/reference');
if (existsSync(target)) throw new Error('Reference already exists; refusing to overwrite the oracle.');
const files = ['README.md', 'config.json', 'package.json', '.gitignore'];
if (existsSync(path.join(root, 'package-lock.json'))) files.push('package-lock.json');
function collect(dir) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (rel === 'tests/reference' || rel === 'tests/performance') continue;
    if (entry.isDirectory()) collect(rel); else if (entry.isFile()) files.push(rel);
  }
}
for (const dir of ['src', 'public', 'tests', 'docs']) collect(dir);
const manifest = { schemaVersion: 1, capturedAt: new Date().toISOString(),
  provenance: 'uncommitted working tree before T01–T04 changes',
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  gitStatus: execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8' }), files: {} };
const storage = { schemaVersion: 1, purpose: 'Accept only Git CRLF/LF conversion; original byte hashes remain in manifest.json', files: {} };
for (const rel of files.sort()) {
  const bytes = readFileSync(path.join(root, rel));
  const dest = path.join(target, rel); mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  manifest.files[rel] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  storage.files[rel] = createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
}
writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(path.join(target, 'storage-manifest.json'), JSON.stringify(storage, null, 2) + '\n');
writeFileSync(path.join(target, '.gitattributes'), '# Preserve frozen bytes across checkouts.\n* -text\n');
const fixture = path.join(root, 'tests/fixtures/performance'); mkdirSync(fixture, { recursive: true });
writeFileSync(path.join(fixture, 'production-20hz.json'), readFileSync(path.join(root, 'config.json')));
console.log(`Captured ${files.length} files from the working tree; reference is immutable.`);
