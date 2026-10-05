// Errors the CLI reports without a stack trace. `hint` tells the user what to do next.
export class CdsError extends Error {
  constructor(message: string, readonly hint?: string, readonly exitCode = 1) {
    super(message);
    this.name = 'CdsError';
  }
}
