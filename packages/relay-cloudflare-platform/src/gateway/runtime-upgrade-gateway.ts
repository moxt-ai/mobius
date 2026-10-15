import { runtimeUpgradeSnapshotSchema } from "@moxt-ai/mobius-protocol";
export class RuntimeUpgradeGateway {
    private readonly namespace: DurableObjectNamespace;
    constructor(namespace: DurableObjectNamespace) {
        this.namespace = namespace;
    }
    readonly request = async (runtimeId: string, projectId: string, dispatch: boolean, signal: AbortSignal) => {
        const url = new URL("https://runtime.internal/upgrade-management");
        url.searchParams.set("runtimeId", runtimeId);
        url.searchParams.set("projectId", projectId);
        const response = await this.namespace
            .getByName(runtimeId)
            .fetch(new Request(url, { method: dispatch ? "POST" : "GET", signal }));
        if (!response.ok) {
            throw new Error("Runtime status unavailable");
        }
        return runtimeUpgradeSnapshotSchema.parse(await response.json());
    };
}
