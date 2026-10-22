module.exports = {
    forbidden: [
        {
            /*
             * Lower layers must not reach up into the layers that compose them. The upper layers are named
             * directories, plus the composition entrypoints that live at a package root instead of in an
             * upper-layer directory: the CLI wires storage, authorization, and the daemon together in
             * `runtime.ts`, `run-daemon.ts`, `cli.ts`, and `index.ts`, so a storage module importing one of
             * those is the same violation as importing `di/`. These names are scoped to the CLI package,
             * because a root `index.ts` elsewhere is an ordinary barrel that lower layers may import.
             */
            name: "storage-does-not-depend-on-upper-layers",
            severity: "error",
            from: { path: "^packages/[^/]+/src/(schema|storage|entity|infra)/" },
            to: {
                path: "^packages/[^/]+/src/((service|http|di|composition|gateway|durable-objects)/|(cli|index|run-daemon|runtime)\\.ts$)",
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
            from: { path: "^packages/cli/src/util/" },
            to: { path: "^packages/cli/src/", pathNot: "^packages/cli/src/util/" },
        },
        {
            // Tables, bytes on disk and execution contracts sit below the CLI domain.
            name: "cli-storage-is-below-the-domain",
            severity: "error",
            from: { path: "^packages/cli/src/(schema|storage|infra)/" },
            to: { path: "^packages/cli/src/(acp|agent|session|runtime|daemon|cli)/" },
        },
        {
            // Agent discovery and the local catalog sit below the runtime that publishes them.
            name: "cli-agent-is-below-the-runtime",
            severity: "error",
            from: { path: "^packages/cli/src/agent/" },
            to: { path: "^packages/cli/src/(session|runtime|daemon|cli)/" },
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
