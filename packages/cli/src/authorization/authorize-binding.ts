import { realpath, stat } from "node:fs/promises";

export class LocalAuthorizationError extends Error {
  readonly code = "local_authorization_failed";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "LocalAuthorizationError";
  }
}

export async function authorizeBinding(
  requestedBindingId: string,
  approvedBindingId: string,
  approvedRoot: string,
): Promise<string> {
  if (requestedBindingId !== approvedBindingId) {
    throw new LocalAuthorizationError("The runtime binding is not authorized");
  }

  try {
    const resolvedRoot = await realpath(approvedRoot);
    const metadata = await stat(resolvedRoot);
    if (!metadata.isDirectory()) {
      throw new LocalAuthorizationError("The approved root is not a directory");
    }
    return resolvedRoot;
  } catch (error) {
    if (error instanceof LocalAuthorizationError) {
      throw error;
    }
    throw new LocalAuthorizationError("The approved root cannot be resolved", {
      cause: error,
    });
  }
}
