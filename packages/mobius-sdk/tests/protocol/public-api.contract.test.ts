import { describe, expect, it } from "vitest";
import * as protocol from "../../src/protocol/index.ts";

describe("Protocol public API", () => {
    it("Given the public protocol entrypoint, When inspected at runtime, Then validation schemas stay private", () => {
        const schemaExports = Object.keys(protocol).filter((name) => name.endsWith("Schema"));

        expect(schemaExports).toEqual([]);
    });
});
