let document = '{"keys":[]}';

export default {
    async fetch(request) {
        const url = new URL(request.url);
        if (url.hostname !== "identity.example.test") {
            return fetch(request);
        }
        if (url.pathname === "/.well-known/jwks.json") {
            if (request.method === "PUT") {
                document = await request.text();
                return new Response(null, { status: 204 });
            }
            return new Response(document, { headers: { "content-type": "application/json" } });
        }
        if (url.pathname === "/redirect") {
            return Response.redirect("https://identity.example.test/.well-known/jwks.json", 302);
        }
        return new Response(null, { status: 404 });
    },
};
