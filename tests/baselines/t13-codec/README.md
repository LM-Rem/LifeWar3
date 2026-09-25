# Frozen pre-optimization T13 codec

`board-protocol.js` is copied unchanged from commit `be727c10343f2d957d2dbc0f8f0a09af59dfb807` before the 2026-09-25 row-copy/row-decode optimization. It imports no current production implementation. `codec-optimization.test.js` compares exact wire bytes and restored entries; `codec-compare.mjs` alternates this baseline and the current codec with identical inputs. It is a stage baseline, not the initial game reference.
