import { describe, expect, it } from "vitest";
import { ClerkOrganizationGateway } from "../src/infra/clerk-organization-gateway.ts";

// Clerk requires live credentials and mutable account data. This stateful peer
// implements its HTTP port while retaining the Worker's real Request validation.
class ClerkPeer {
    private readonly organizations = new Map<string, { readonly id: string; readonly name: string }>();
    private readonly redirects = new Map<string, string>();

    readonly create = (id: string, name: string): void => {
        this.organizations.set(id, { id, name });
    };

    readonly move = (id: string, location: string): void => {
        this.organizations.delete(id);
        this.redirects.set(id, location);
    };

    readonly fetch: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        request.signal.throwIfAborted();
        if (request.headers.get("authorization") !== "Bearer sk_test_example") {
            return new Response(null, { status: 401 });
        }
        const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
        const location = this.redirects.get(id);
        if (location !== undefined) {
            return Response.redirect(location, 302);
        }
        const organization = this.organizations.get(id);
        return organization === undefined ? new Response(null, { status: 404 }) : Response.json(organization);
    };
}

describe("Clerk organization HTTP boundary in Workers", () => {
    it("Given an existing Clerk organization, When the Worker requests its details, Then its ID and name are returned", async () => {
        const clerk = new ClerkPeer();
        clerk.create("org_example", "Mobius");
        const gateway = new ClerkOrganizationGateway("sk_test_example", clerk.fetch);

        await expect(gateway.organization("org_example", new AbortController().signal)).resolves.toEqual({
            id: "org_example",
            name: "Mobius",
        });
    });

    it("Given Clerk redirects an organization request, When the Worker requests its details, Then the redirect is rejected as unavailable", async () => {
        const clerk = new ClerkPeer();
        clerk.create("org_example", "Mobius");
        clerk.move("org_example", "https://other.example/organization");
        const gateway = new ClerkOrganizationGateway("sk_test_example", clerk.fetch);

        await expect(gateway.organization("org_example", new AbortController().signal)).rejects.toMatchObject({
            code: "clerk_unavailable",
            status: 503,
        });
    });
});
