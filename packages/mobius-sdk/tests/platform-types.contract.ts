import type { ProjectLocationHint } from "@moxt-ai/mobius-sdk/protocol";
import type { MobiusCreatePlatformProjectRequest } from "../src/platform.ts";

const request: MobiusCreatePlatformProjectRequest = {
    clientReference: "user-1",
    displayName: "Personal workspace",
    idempotencyKey: "project-1",
    locationHint: "wnam",
};

// @ts-expect-error Unsupported Project location hints must be rejected by SDK consumers.
const unsupportedLocationHint: ProjectLocationHint = "moon";

void request;
void unsupportedLocationHint;
