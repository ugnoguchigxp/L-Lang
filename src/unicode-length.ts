/** Counts Unicode scalar values. Callers must reject unpaired surrogates first. */
export function unicodeScalarLength(value: string): number {
  return [...value].length;
}
