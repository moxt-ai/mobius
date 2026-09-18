import type { Env, MiddlewareHandler } from "hono";
import { assertExactKeys, parseJsonBody } from "../../infra/relay-http.ts";

export type ParsedBodyInput = {
    readonly in: { readonly json: unknown };
    readonly out: { readonly json: Readonly<Record<string, unknown>> };
};

function parsedBodyParser<TEnvironment extends Env, TPath extends string = string>(
    parse: (request: Request) => Promise<Readonly<Record<string, unknown>>>,
    shouldParse: (request: Request) => boolean = () => true,
): MiddlewareHandler<TEnvironment, TPath, ParsedBodyInput> {
    return async (context, next) => {
        if (shouldParse(context.req.raw)) {
            context.req.addValidatedData("json", await parse(context.req.raw));
        }
        await next();
    };
}

export function bodyParser<TEnvironment extends Env, TPath extends string = string>(
    fields?: readonly string[],
    maximumLength?: number,
): MiddlewareHandler<TEnvironment, TPath, ParsedBodyInput> {
    return parsedBodyParser<TEnvironment, TPath>(async (request) => {
        const body = await parseJsonBody(request, maximumLength);
        if (fields !== undefined) {
            assertExactKeys(body, fields);
        }
        return body;
    });
}
