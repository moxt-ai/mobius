export interface HttpErrorJson {
    readonly body: { readonly error: { readonly code: string; readonly message: string } };
    readonly status: number;
    readonly headers?: Readonly<Record<string, string>>;
}

export interface HttpError extends Error {
    readonly toHttpJson: () => HttpErrorJson;
}

export function isHttpError(error: unknown): error is Error & HttpError {
    return error instanceof Error && "toHttpJson" in error && typeof error.toHttpJson === "function";
}
