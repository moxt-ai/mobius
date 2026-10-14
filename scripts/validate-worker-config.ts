const variableNames = [
    "MOBIUS_PLATFORM_ALLOWED_ORIGINS",
    "MOBIUS_PLATFORM_OIDC_PROVIDERS",
    "MOBIUS_PLATFORM_OPERATOR_SUBJECTS",
    "SESSION_ACTIVE_SESSIONS_PER_PROJECT",
];

const variables: Record<string, string> = {};
for (const name of variableNames) {
    const value = process.env[name];
    if (!value?.trim() || value.includes("\0")) {
        console.error(`Missing or invalid GitHub runtime variable: ${name}`);
        process.exit(1);
    }
    variables[name] = value;
}

const clerkSecretKey = process.env["CLERK_SECRET_KEY"];
if (
    clerkSecretKey !== undefined &&
    clerkSecretKey !== "" &&
    (!clerkSecretKey.trim() || clerkSecretKey.includes("\0"))
) {
    console.error("Invalid CLERK_SECRET_KEY GitHub secret");
    process.exit(1);
}

const webhookSecretEncryptionKey = process.env["MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY"];
if (webhookSecretEncryptionKey !== undefined && webhookSecretEncryptionKey !== "") {
    try {
        if (
            !webhookSecretEncryptionKey.trim() ||
            webhookSecretEncryptionKey.includes("\0") ||
            atob(webhookSecretEncryptionKey).length !== 32
        ) {
            throw new Error("invalid key");
        }
    } catch {
        console.error("Invalid MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY GitHub secret");
        process.exit(1);
    }
}

const secrets: Record<string, string> = {};
if (clerkSecretKey) {
    secrets["CLERK_SECRET_KEY"] = clerkSecretKey;
}
if (webhookSecretEncryptionKey) {
    secrets["MOBIUS_SESSION_WEBHOOK_SECRET_ENCRYPTION_KEY"] = webhookSecretEncryptionKey;
}

switch (process.argv[2] ?? "validate") {
    case "validate":
        console.log("Validated GitHub runtime variables for Platform");
        break;
    case "vars":
        process.stdout.write(JSON.stringify(variables));
        break;
    case "secrets":
        process.stdout.write(JSON.stringify(secrets));
        break;
    default:
        console.error("Expected validate, vars, or secrets");
        process.exit(1);
}
