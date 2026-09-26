// User-facing launch defaults. Explicit environment overrides take precedence.
// Keep imported createServer() and benchmark/test defaults independent.
process.env.LIFEWAR_EVOLUTION ??= 'gpu';
process.env.LIFEWAR_BOARD_PROTOCOL ??= '2';
