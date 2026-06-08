/**
 * Coerce a number <input>'s raw string value while preserving an empty field.
 * Number("") is 0, which makes a controlled number input snap back to 0 and
 * traps the caret after it. Returning "" lets the field be cleared.
 */
export function parseNumberField(raw: string): number | "" {
  return raw === "" ? "" : Number(raw);
}

/** True when value is a finite number >= 1 (a valid duration/retention entry). */
export function isPositiveNumberField(value: number | ""): value is number {
  return value !== "" && Number.isFinite(value) && value >= 1;
}
