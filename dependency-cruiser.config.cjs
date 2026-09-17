module.exports = {
    forbidden: [
        {
            name: "storage-does-not-depend-on-upper-layers",
            severity: "error",
            from: { path: "^packages/[^/]+/src/(schema|storage|entity|infra)/" },
            to: { path: "^packages/[^/]+/src/(service|http|di|composition|gateway|durable-objects)/", reachable: true },
        },
        {
            name: "relay-core-does-not-depend-on-hosts",
            severity: "error",
            from: { path: "^packages/relay-core/src/" },
            to: { path: "^packages/(relay-cloudflare-platform|relay-cloudflare-standalone)/" },
        },
        {
            name: "protocol-does-not-depend-on-implementations",
            severity: "error",
            from: { path: "^packages/protocol/src/" },
            to: { path: "^packages/", pathNot: "^packages/protocol/" },
        },
        {
            name: "hosting-implementations-are-independent",
            severity: "error",
            from: { path: "^packages/relay-cloudflare-(platform|standalone)/src/" },
            to: {
                path: "^packages/relay-cloudflare-(platform|standalone)/src/",
                pathNot: "^packages/relay-cloudflare-$1/",
            },
        },
    ],
    options: {
        doNotFollow: { path: "node_modules" },
        tsPreCompilationDeps: true,
        enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types", "default"] },
    },
};
