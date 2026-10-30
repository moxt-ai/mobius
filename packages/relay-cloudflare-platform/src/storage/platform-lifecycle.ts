import { eq } from "drizzle-orm";
import { platformApp, platformProject } from "../schema/d1/index.ts";

/*
 * Lifecycle rules of the Platform directory. Each entity records its own lifecycle and every reader consults only
 * that record. PlatformControlPlaneStorage.deleteApp is the single writer that ends an App: in one batch it records
 * the App, each of its Projects and each of its AppCredentials as ended. A Project or AppCredential is created only
 * by a statement that requires its App to be active, so an active Project or credential never outlives its App.
 */

/** Whether an App is active. */
export const appActive = eq(platformApp.lifecycle, "active");

/** Whether the Relay serves a Project and its storage. */
export const projectServed = eq(platformProject.lifecycle, "active");
