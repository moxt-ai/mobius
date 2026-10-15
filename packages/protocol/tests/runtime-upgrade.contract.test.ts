import { describe, expect, it } from "vitest";
import { decodeDaemonToServiceMessage, decodeServiceToDaemonMessage } from "../src/index.ts";

describe("Runtime upgrade wire contract", () => {
    it("Given an exact npm version, When the service requests upgrade, Then the daemon accepts the bounded request", () => {
        const request = { kind: "runtime.upgrade.request", requestId: "upgrade_1", version: "0.0.228" };
        expect(decodeServiceToDaemonMessage(JSON.stringify(request))).toEqual(request);
    });
    it.each(["latest", "../evil", "https://example.com/a.tgz", "1.2.3 --script=evil", "^1.2.3"])(
        "Given an unsafe target %s, When requested, Then it is rejected",
        (version) => {
            expect(() =>
                decodeServiceToDaemonMessage(
                    JSON.stringify({ kind: "runtime.upgrade.request", requestId: "upgrade_1", version }),
                ),
            ).toThrow();
        },
    );
    it("Given a rolled back daemon, When it reports failure, Then the service receives a correlated error and cooldown", () => {
        const result = {
            kind: "runtime.upgrade.result",
            requestId: "upgrade_1",
            version: "0.0.227",
            targetVersion: "0.0.228",
            outcome: {
                status: "failed",
                code: "worker_exited",
                message: "The new daemon exited before becoming ready",
                retryAfter: 3600000,
            },
        };
        expect(decodeDaemonToServiceMessage(JSON.stringify(result))).toEqual(result);
    });
});
