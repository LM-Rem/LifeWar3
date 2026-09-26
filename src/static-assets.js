import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
const compress = promisify(gzip);
export function staticAssets() {
  const cache = new Map();
  return async function serve(req, res, file, headers) {
    const info = await stat(file), signature = `${info.mtimeMs}/${info.ctimeMs}/${info.size}`;
    let entry = cache.get(file);
    if (!entry || entry.signature !== signature) {
      const data = await readFile(file);
      const zipped = data.length >= 1024 && /text|javascript|json|svg/.test(headers['Content-Type']) ? await compress(data, { level: 6 }) : null;
      entry = { signature, data, zipped: zipped?.length < data.length ? zipped : null, hash: createHash('sha256').update(data).digest('hex') };
      // Only cache reasonably sized public assets, with bounded total storage.
      if (data.length <= 4 * 1024 * 1024) {
        cache.delete(file); cache.set(file, entry);
        while (cache.size > 32 || [...cache.values()].reduce((n, e) => n + e.data.length + (e.zipped?.length ?? 0), 0) > 16 * 1024 * 1024) cache.delete(cache.keys().next().value);
      }
    }
    const acceptsGzip = (req.headers['accept-encoding'] ?? '').split(',').some(part => {
      const [name, ...params] = part.trim().split(';');
      return name.toLowerCase() === 'gzip' && !params.some(p => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(p));
    });
    const zipped = acceptsGzip && entry.zipped;
    const etag = `"${entry.hash}${zipped ? '-gzip' : ''}"`;
    const responseHeaders = { ...headers, ETag: etag, Vary: 'Accept-Encoding' };
    if (zipped) responseHeaders['Content-Encoding'] = 'gzip';
    if ((req.headers['if-none-match'] ?? '').split(',').some(tag => tag.trim().replace(/^W\//, '') === etag || tag.trim() === '*')) {
      res.writeHead(304, responseHeaders); res.end(); return;
    }
    const body = zipped || entry.data;
    res.writeHead(200, { ...responseHeaders, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
