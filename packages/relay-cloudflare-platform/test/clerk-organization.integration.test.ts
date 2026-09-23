import { describe, expect, it } from "vitest";
import { FakeClerk } from "../../../tests/infra/clerk.ts";
import { ClerkOrganizationGateway } from "../src/infra/clerk-organization-gateway.ts";

describe("Clerk organization HTTP boundary in Workers", () => {
    it("Given an existing Clerk organization, When the Worker requests its details, Then its ID and name are returned", async () => {
        const clerk = new FakeClerk();
        clerk.createOrganization("org_example", "Mobius");
        const gateway = new ClerkOrganizationGateway(clerk.secret, clerk.fetch);

        await expect(gateway.organization("org_example", new AbortController().signal)).resolves.toEqual({
            id: "org_example",
            name: "Mobius",
        });
    });

    it("Given Clerk redirects an organization request, When the Worker requests its details, Then the redirect is rejected as unavailable", async () => {
        const clerk = new FakeClerk();
        clerk.createOrganization("org_example", "Mobius");
        clerk.moveOrganization("org_example", "https://other.example/organization");
        const gateway = new ClerkOrganizationGateway(clerk.secret, clerk.fetch);

        await expect(gateway.organization("org_example", new AbortController().signal)).rejects.toMatchObject({
            code: "clerk_unavailable",
            status: 503,
        });
    });
});
