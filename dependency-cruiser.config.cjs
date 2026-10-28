module.exports = {
    forbidden: [
        {
            /*
             * Lower layers must not reach up into the layers that compose them. The upper layers are named
             * directories, plus the composition entrypoints that live at a package root instead of in an
             * upper-layer directory: the CLI wires storage, authorization, and the daemon together in
             * `exports/engine.ts`, `run-daemon.ts`, and `cli.ts`, so a storage module importing one of
             * those is the same violation as importing `di/`. These names are scoped to the CLI package,
             * because a root `index.ts` elsewhere is an ordinary barrel that lower layers may import.
             */
            name: "storage-does-not-depend-on-upper-layers",
            severity: "error",
            from: { path: "^packages/[^/]+/src/(engine/)?(schema|storage|entity|infra)/" },
            to: {
                path: "^packages/[^/]+/src/((service|http|di|composition|gateway|durable-objects|exports)/|(cli|index|run-daemon|runtime)\\.ts$)",
                pathNot: "^packages/(?!cli/)[^/]+/src/index\\.ts$",
                reachable: true,
            },
        },
        {
            // The CLI source has no import cycles, so each directory can be read and changed from the
            // bottom up. Vendored harness code is outside the rule.
            name: "cli-no-circular",
            severity: "error",
            from: { path: "^packages/cli/src/", pathNot: "/upstream/" },
            to: { circular: true },
        },
        {
            // Generic helpers stay free of Mobius concepts.
            name: "cli-util-is-a-leaf",
            severity: "error",
            from: { path: "^packages/cli/src/engine/util/" },
            to: { path: "^packages/cli/src/", pathNot: "^packages/cli/src/engine/util/" },
        },
        {
            // Tables, bytes on disk and execution contracts sit below the CLI domain.
            name: "cli-storage-is-below-the-domain",
            severity: "error",
            from: { path: "^packages/cli/src/engine/(schema|storage|infra)/" },
            to: { path: "^packages/cli/src/(engine/(acp|agent|session|runtime)/|daemon/|cli/|exports/)" },
        },
        {
            // Only storage/ and util/ touch the disk; the layers above reach files through them.
            name: "cli-disk-access-stays-in-storage",
            severity: "error",
            from: { path: "^packages/cli/src/", pathNot: "^packages/cli/src/engine/(storage|util)/|/upstream/" },
            to: { dependencyTypes: ["core"], path: "^(node:)?(fs|fs/promises|sqlite)$" },
        },
        {
            // Queries live with the tables in storage/; schema/ only declares them.
            name: "cli-database-access-stays-in-storage",
            severity: "error",
            from: { path: "^packages/cli/src/", pathNot: "^packages/cli/src/engine/(storage|schema)/|/upstream/" },
            to: { path: "/node_modules/drizzle-orm/" },
        },
        {
            // Agent discovery and the local catalog sit below the runtime that publishes them.
            name: "cli-agent-is-below-the-runtime",
            severity: "error",
            from: { path: "^packages/cli/src/engine/agent/" },
            to: { path: "^packages/cli/src/(engine/(session|runtime)/|daemon/|cli/|exports/)" },
        },
        {
            // The runtime composes sessions; it never speaks the agent protocol itself.
            name: "cli-runtime-does-not-import-acp",
            severity: "error",
            from: { path: "^packages/cli/src/engine/runtime/" },
            to: { path: "^packages/cli/src/(engine/acp/|daemon/|exports/)" },
        },
        {
            // The session layer decides; the runtime only calls it.
            name: "cli-session-does-not-import-upper-layers",
            severity: "error",
            from: { path: "^packages/cli/src/engine/session/" },
            to: { path: "^packages/cli/src/(engine/runtime/|daemon/|cli/|exports/)" },
        },
        {
            name: "relay-core-does-not-depend-on-hosts",
            severity: "error",
            from: { path: "^packages/relay-core/src/" },
            to: { path: "^packages/relay-cloudflare-platform/" },
        },
        {
            name: "protocol-does-not-depend-on-implementations",
            severity: "error",
            from: { path: "^packages/mobius-sdk/src/protocol/" },
            to: { path: "^packages/", pathNot: "^packages/mobius-sdk/" },
        },
    ],
    options: {
        doNotFollow: { path: "node_modules" },
        tsPreCompilationDeps: true,
        enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types", "default"] },
    },
};
