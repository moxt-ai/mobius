import { MobiusError } from "@moxt-ai/mobius-sdk/server";

export class MiniClientError extends Error {
    readonly code: string;

    constructor(code: string, message: string, options: ErrorOptions = {}) {
        super(message, options);
        this.code = code;
        this.name = "MiniClientError";
    }
}

export function errorOutput(cause: unknown): { readonly error: { readonly code: string; readonly message: string } } {
    if (cause instanceof MiniClientError || cause instanceof MobiusError) {
        return { error: { code: cause.code, message: cause.message } };
    }
    return {
        error: {
            code: "mini_client_failed",
            message: cause instanceof Error ? cause.message : "The mini-client operation failed",
        },
    };
}
