import { FieldTree, ValidationError } from '@angular/forms/signals';
import { FieldViolation } from '@apps/drawboard-api';

/**
 * User-facing text per Bean Validation constraint (FieldViolation.code). The backend's own
 * message is technical (the Pattern message contains the regex). i18n hook: replace this map.
 */
const CONSTRAINT_MESSAGES: Readonly<Record<string, string>> = {
  NotNull: 'Required.',
  NotBlank: 'Required.',
  NotEmpty: 'Required.',
  Size: 'The length is not allowed.',
  Pattern: 'Must contain at least one character that is not a space.',
  Min: 'The value is too small.',
  Max: 'The value is too large.',
  Email: 'Not a valid e-mail address.',
};

/**
 * Walks a violation path of the backend ("title", "address.street", "items[2].name") down the
 * FieldTree. Undefined when the form has no such field - the error then lands on the form root.
 */
export function fieldAt(root: FieldTree<unknown>, path: string): FieldTree<unknown> | undefined {
  const segments = path.split(/\.|\[(\d+)\]/).filter((segment) => !!segment);
  let current: unknown = root;
  for (const segment of segments) {
    if (current === undefined || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current as FieldTree<unknown> | undefined;
}

/**
 * Server violations -> Signal Forms submission errors. Return the result from the form's
 * submission action: Angular shows each error at its field (`field().errors()`) and clears it
 * as soon as the value of that field changes.
 */
export function violationsToFieldErrors(
  root: FieldTree<unknown>,
  violations: readonly FieldViolation[],
): ValidationError.WithOptionalFieldTree[] {
  return violations.map((violation) => ({
    kind: `server:${violation.code}`,
    message: CONSTRAINT_MESSAGES[violation.code] ?? violation.message,
    fieldTree: fieldAt(root, violation.field),
  }));
}
