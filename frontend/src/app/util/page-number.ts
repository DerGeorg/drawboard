/**
 * Query parameter ?page=N (1-based, as users read it) -> zero-based page for the API.
 * Missing, garbage or < 1 means the first page. withComponentInputBinding() passes
 * `undefined` when the parameter is absent - numberAttribute alone would turn that into NaN.
 */
export function pageIndexFromQuery(value: unknown): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page - 1 : 0;
}
