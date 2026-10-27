export async function authorizeMessageIdMigration(
    request: Request,
    token: string | undefined,
): Promise<Response | null> {
    if (token === undefined || token.length < 32) {
        return Response.json({ error: { code: "migration_disabled" } }, { status: 503 });
    }
    const encoder = new TextEncoder();
    const [actual, expected] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(request.headers.get("authorization") ?? "")),
        crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${token}`)),
    ]);
    if (!crypto.subtle.timingSafeEqual(actual, expected)) {
        return Response.json({ error: { code: "migration_forbidden" } }, { status: 403 });
    }
    return null;
}
