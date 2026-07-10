export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class PromptCancelledError extends CodexAuthError {
  constructor() {
    super("No account selected. The operation was cancelled.");
  }
}
