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
