/**
 * Dotted-path access used by the animation engine: a track addresses its target
 * as `style.extrusion.depth`, and evaluation writes the interpolated value back
 * into a cloned layer through `setPath`.
 */

export type Plain = Record<string, unknown>;

export function getPath(target: unknown, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = target;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Plain)[segment];
  }
  return current;
}

/**
 * Writes `value` at `path`, mutating `target`. Missing intermediate objects are
 * created so a track can address a property the layer does not carry yet.
 */
export function setPath(target: Plain, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop();
  if (!last) return;

  let current: Plain = target;
  for (const segment of segments) {
    const next = current[segment];
    if (next === null || typeof next !== 'object') {
      current[segment] = {};
    }
    current = current[segment] as Plain;
  }
  current[last] = value;
}

/** structuredClone with a JSON fallback for the (rare) environment lacking it. */
export function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function generateId(prefix = 'id'): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${random}`;
}
