import { createPlatformWorker } from "./platform-worker.ts";

export { ProjectDO } from "./durable-objects/project-do.ts";
export * from "./platform-worker.ts";

export default createPlatformWorker();
