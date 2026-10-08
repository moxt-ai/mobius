import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { bodyParser } from "../../relay-core/src/http/middleware/body-parser.ts";

describe("Relay JSON request boundary", () => {
    it("Given a valid JSON body larger than 16 KiB, When a route uses the default parser, Then the request is accepted", async () => {
        const app = new Hono().post("/json", bodyParser(), (context) => context.json(context.req.valid("json")));
        const value = "x".repeat(32 * 1024);

        const response = await app.request("/json", {
            body: JSON.stringify({ value }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ value });
    });
});
