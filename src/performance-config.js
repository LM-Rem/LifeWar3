export function performanceConfig(env = process.env) {
  const trace = env.LIFEWAR_TRACE ?? '0';
  if (!['0', '1'].includes(trace)) throw new Error('LIFEWAR_TRACE must be 0 or 1');
  const capacity = Number(env.LIFEWAR_TRACE_CAPACITY ?? 16384);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000000) throw new Error('Invalid LIFEWAR_TRACE_CAPACITY');
  return { enabled: trace === '1', capacity };
}
