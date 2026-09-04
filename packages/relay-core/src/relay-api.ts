import { MOBIUS_PROTOCOL_VERSION } from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";

import type { ChannelRuntime } from "./channel-runtime.ts";
import {
  type PairingDirectory,
  PairingDirectoryError,
  validateAgents,
  validateDisplayName,
  validateIdentifier,
  validatePairingCode,
} from "./pairing-directory.ts";

const MAX_REQUEST_BODY_LENGTH = 16 * 1024;

export interface RelayDependencies {
  readonly channelRuntime: ChannelRuntime;
  readonly pairingDirectory: PairingDirectory;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) {
      throw new PairingDirectoryError(
        "invalid_request",
        `Unexpected request field: ${key}`,
      );
    }
  }
  for (const key of expected) {
    if (!(key in value)) {
      throw new PairingDirectoryError(
        "invalid_request",
        `Missing request field: ${key}`,
      );
    }
  }
}

async function parseJsonBody(
  request: Request,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  signal.throwIfAborted();
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (
    !Number.isFinite(contentLength) ||
    contentLength < 0 ||
    contentLength > MAX_REQUEST_BODY_LENGTH
  ) {
    throw new PairingDirectoryError(
      "invalid_request",
      "The request body is too large",
    );
  }

  const encoded = await request.text();
  signal.throwIfAborted();
  if (encoded.length === 0 || encoded.length > MAX_REQUEST_BODY_LENGTH) {
    throw new PairingDirectoryError(
      "invalid_request",
      "The request body is invalid",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (error) {
    throw new PairingDirectoryError(
      "invalid_request",
      "The request body is not valid JSON",
      { cause: error },
    );
  }
  if (!isRecord(value)) {
    throw new PairingDirectoryError(
      "invalid_request",
      "The request body must be a JSON object",
    );
  }
  return value;
}

function reportUnexpectedError(error: unknown): void {
  console.error("Mobius relay request failed", error);
}

function preserveCancellation(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) {
    throw error;
  }
}

function channelConnectionError(error: unknown): Response {
  if (error instanceof PairingDirectoryError) {
    const status = error.code === "channel_not_found" ? 404 : 401;
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status },
    );
  }
  reportUnexpectedError(error);
  return Response.json(
    {
      error: {
        code: "directory_unavailable",
        message: "The channel directory is unavailable",
      },
    },
    { status: 503 },
  );
}

export function createRelayApp(dependencies: RelayDependencies): Hono {
  const app = new Hono();

  app.get("/health", (context) =>
    context.json({
      protocolVersion: MOBIUS_PROTOCOL_VERSION,
      service: "mobius-relay",
      status: "ok",
    }),
  );

  app.post("/v1/pairings", async (context) => {
    try {
      const pairing = await dependencies.pairingDirectory.createPairing(
        context.req.raw.signal,
      );
      return context.json(
        {
          channelId: pairing.channelId,
          expiresAt: pairing.expiresAt,
          pairingCode: pairing.pairingCode,
          pairingId: pairing.pairingId,
          pollToken: pairing.pollToken,
        },
        201,
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      reportUnexpectedError(error);
      return context.json(
        {
          error: {
            code: "directory_unavailable",
            message: "The pairing directory is unavailable",
          },
        },
        503,
      );
    }
  });

  app.get("/v1/pairings/:pairingId", async (context) => {
    try {
      const pairingId = validateIdentifier(
        context.req.param("pairingId"),
        "pairing_id",
      );
      const pollToken = context.req.query("token") ?? "";
      return context.json(
        await dependencies.pairingDirectory.readPairingStatus(
          pairingId,
          pollToken,
          context.req.raw.signal,
        ),
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      if (error instanceof PairingDirectoryError) {
        if (error.code === "pairing_not_found") {
          return context.json(
            { error: { code: error.code, message: error.message } },
            404,
          );
        }
        return context.json(
          { error: { code: error.code, message: error.message } },
          401,
        );
      }
      reportUnexpectedError(error);
      return context.json(
        {
          error: {
            code: "directory_unavailable",
            message: "The pairing directory is unavailable",
          },
        },
        503,
      );
    }
  });

  app.post("/v1/pairings/claim", async (context) => {
    try {
      const body = await parseJsonBody(context.req.raw, context.req.raw.signal);
      assertExactKeys(body, [
        "agents",
        "machineName",
        "pairingCode",
        "workspaceName",
      ]);
      return context.json(
        await dependencies.pairingDirectory.claimPairing(
          validatePairingCode(body["pairingCode"]),
          validateDisplayName(body["machineName"], "machine_name"),
          validateDisplayName(body["workspaceName"], "workspace_name"),
          validateAgents(body["agents"]),
          context.req.raw.signal,
        ),
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      if (error instanceof PairingDirectoryError) {
        return context.json(
          { error: { code: error.code, message: error.message } },
          400,
        );
      }
      reportUnexpectedError(error);
      return context.json(
        {
          error: {
            code: "directory_unavailable",
            message: "The pairing directory is unavailable",
          },
        },
        503,
      );
    }
  });

  app.get("/v1/channels/:channelId", async (context) => {
    try {
      return context.json(
        await dependencies.pairingDirectory.readChannel(
          validateIdentifier(context.req.param("channelId"), "channel_id"),
          context.req.raw.signal,
        ),
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      if (error instanceof PairingDirectoryError) {
        if (error.code === "channel_not_found") {
          return context.json(
            { error: { code: error.code, message: error.message } },
            404,
          );
        }
        return context.json(
          { error: { code: error.code, message: error.message } },
          400,
        );
      }
      reportUnexpectedError(error);
      return context.json(
        {
          error: {
            code: "directory_unavailable",
            message: "The channel directory is unavailable",
          },
        },
        503,
      );
    }
  });

  app.get("/v1/channels/:channelId/history", async (context) => {
    const channelId = context.req.param("channelId");
    let validatedChannelId = "";
    try {
      validatedChannelId = validateIdentifier(channelId, "channel_id");
      await dependencies.pairingDirectory.readChannel(
        validatedChannelId,
        context.req.raw.signal,
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      if (error instanceof PairingDirectoryError) {
        if (error.code === "channel_not_found") {
          return context.json(
            { error: { code: error.code, message: error.message } },
            404,
          );
        }
        return context.json(
          { error: { code: error.code, message: error.message } },
          400,
        );
      }
      reportUnexpectedError(error);
      return context.json(
        {
          error: {
            code: "directory_unavailable",
            message: "The channel directory is unavailable",
          },
        },
        503,
      );
    }
    return await dependencies.channelRuntime.readHistory(
      validatedChannelId,
      context.req.raw,
      context.req.raw.signal,
    );
  });

  app.get("/v1/channels/:channelId/host", async (context) => {
    const channelId = context.req.param("channelId");
    let validatedChannelId = "";
    try {
      validatedChannelId = validateIdentifier(channelId, "channel_id");
      await dependencies.pairingDirectory.authorizeHost(
        validatedChannelId,
        context.req.raw.signal,
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return channelConnectionError(error);
    }
    return await dependencies.channelRuntime.acceptHost(
      validatedChannelId,
      context.req.raw,
      context.req.raw.signal,
    );
  });

  app.get("/v1/channels/:channelId/daemon", async (context) => {
    const channelId = context.req.param("channelId");
    let validatedChannelId = "";
    try {
      validatedChannelId = validateIdentifier(channelId, "channel_id");
      await dependencies.pairingDirectory.authorizeDaemon(
        validatedChannelId,
        context.req.query("token") ?? "",
        context.req.raw.signal,
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return channelConnectionError(error);
    }
    return await dependencies.channelRuntime.acceptDaemon(
      validatedChannelId,
      context.req.raw,
      context.req.raw.signal,
    );
  });

  return app;
}
