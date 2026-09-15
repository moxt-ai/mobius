const variableNames = [
    "MOBIUS_PLATFORM_ALLOWED_ORIGINS",
    "MOBIUS_PLATFORM_OIDC_PROVIDERS",
    "MOBIUS_PLATFORM_OPERATOR_SUBJECTS",
    "SESSION_ACTIVE_SESSIONS_PER_PROJECT",
    "SESSION_ARCHIVE_BYTES_PER_SESSION",
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

if (!process.env["VITE_CLERK_PUBLISHABLE_KEY"]?.trim()) {
    console.error("Missing CLERK_PUBLISHABLE_KEY GitHub variable");
    process.exit(1);
}

const key = process.env["CLERK_SECRET_KEY"];
if (key !== undefined && key !== "" && (!key.trim() || key.includes("\0"))) {
    console.error("Invalid CLERK_SECRET_KEY GitHub secret");
    process.exit(1);
}

switch (process.argv[2] ?? "validate") {
    case "validate":
        console.log("Validated GitHub runtime variables for Platform");
        break;
    case "vars":
        process.stdout.write(JSON.stringify(variables));
        break;
    case "secrets": {
        process.stdout.write(JSON.stringify(key ? { CLERK_SECRET_KEY: key } : {}));
        break;
    }
    default:
        console.error("Expected validate, vars, or secrets");
        process.exit(1);
}
