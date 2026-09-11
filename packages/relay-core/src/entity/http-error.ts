export interface HttpError {
    readonly code: string;
    readonly httpStatus: number;
}

export function isHttpError(error: unknown): error is Error & HttpError {
    if (!(error instanceof Error)) {
        return false;
    }
    const code = Reflect.get(error, "code");
    const httpStatus = Reflect.get(error, "httpStatus");
    return (
        typeof code === "string" &&
        code.length > 0 &&
        typeof httpStatus === "number" &&
        Number.isSafeInteger(httpStatus) &&
        httpStatus >= 400 &&
        httpStatus <= 599
    );
}
