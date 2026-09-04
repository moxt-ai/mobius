import { type ClientApp, client } from "@agentclientprotocol/sdk";

export const createAcpClient = (): ClientApp => client({ name: "mobius" });
