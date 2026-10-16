export class RuntimeUpgradeRequiredError extends Error {
    readonly code = "runtime_upgrade_required";

    constructor() {
        super("The Relay requires a newer daemon version; upgrade @moxt-ai/mobius");
        this.name = "RuntimeUpgradeRequiredError";
    }
}
