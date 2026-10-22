// Own module so content-redact.ts and inputs.ts do not import each other.
/** Refusal of an input (CLI exit 1). */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}
