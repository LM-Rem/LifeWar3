# Dense minimap, codec and end-to-end A/B

Goal: preserve exact pixels, cell order and every generation while reducing CPU cost.
Architecture: retain Canvas primitives unless browser pixel comparison proves batching equivalent; optimize the existing v2 wire format without relaxing validation. Compare the frozen initial implementation, current v1 and opt-in v2 serially under the same synthetic workload.
Tech stack: Node.js, Canvas 2D, existing installed Playwright/Chrome, ws.

1. Evaluate ordered same-color paths and non-overlapping paths against individual fillRect calls, including fractional coordinates and dense overlap. Save mismatches; reject any nonzero difference. Do not add another cache to hide full redraw cost.
2. Optimize dense tile row traversal and order restoration in public/board-protocol.js; avoid no-op writes in public/renderer.js. Run protocol malformed-input/order tests, randomized replay and frozen-renderer comparisons.
3. Add a serial end-to-end benchmark using real WebSocket transport and RAF, initial/current engines and renderers, identical warmup and seed. Record full step/encode/send tick, client work and RAF intervals, generations, queue, actual bytes and memory samples. Keep correctness checks outside timed runs.
4. Run repeated A/B and document all failures and source hashes. Local headless runs are not four physical foreground clients, LAN certification or a 30-minute/2-hour soak; report these limits explicitly.
