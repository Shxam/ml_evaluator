/**
 * Deterministic JSON serialization utility.
 * Recursively sorts all object keys lexicographically.
 * Preserves array element ordering.
 * Outputs UTF-8 formatted JSON string.
 */

function sortKeysRecursively(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => sortKeysRecursively(item));
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const result: Record<string, unknown> = {};

  for (const key of sortedKeys) {
    result[key] = sortKeysRecursively(record[key]);
  }

  return result;
}

export function toDeterministicJson(value: unknown, indent: number = 2): string {
  const sorted = sortKeysRecursively(value);
  return JSON.stringify(sorted, null, indent) + '\n';
}
