import { writeFileSync } from "node:fs";

// Private subprocess fixture: records the Mobius state directory this Agent inherited, then runs the controlled peer.
const record = process.env["MOBIUS_TEST_ENVIRONMENT_RECORD"];
if (record === undefined) {
    throw new Error("The environment recorder needs MOBIUS_TEST_ENVIRONMENT_RECORD");
}
writeFileSync(record, JSON.stringify({ stateDirectory: process.env["MOBIUS_STATE_DIRECTORY"] ?? null }));
await import("./acp-peer.ts");
