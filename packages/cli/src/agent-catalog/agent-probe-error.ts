export class AgentProbeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.code = code;
    this.name = "AgentProbeError";
  }
}
