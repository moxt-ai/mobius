import { createPlatformWorker } from "./platform-worker.ts";

export { ProjectRelay } from "./durable-objects/project-relay.ts";
export * from "./platform-worker.ts";

export default createPlatformWorker();
