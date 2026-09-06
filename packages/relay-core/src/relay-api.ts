import { MOBIUS_PROTOCOL_VERSION } from "@moxt-ai/mobius-protocol";
import { Hono } from "hono";

import {
  RequestBodyError,
  readBoundedUtf8Body,
} from "./bounded-request-body.ts";
import type { ChannelRuntime } from "./channel-runtime.ts";
import {
  type PairingDirectory,
  PairingDirectoryError,
  validateAgentCatalog,
  validateAgents,
  validateDisplayName,
  validateIdentifier,
  validateInstallableAgents,
  validatePairingCode,
} from "./pairing-directory.ts";
import {
  CreateSessionRequest,
  ProjectScope,
  SessionRecordingPolicy,
  type SessionRuntime,
  SessionRuntimeError,
} from "./session-runtime.ts";

const MAX_REQUEST_BODY_LENGTH = 16 * 1024;
const MAX_IMPORT_BODY_LENGTH = 96 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export interface RelayDependencies {
  readonly channelRuntime: ChannelRuntime;
  readonly pairingDirectory: PairingDirectory;
  readonly sessionRuntime: SessionRuntime;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    throw new PairingDirectoryError(
      "invalid_request",
      "The request fields are invalid",
    );
  }
}

async function parseJsonBody(
  request: Request,
  maximumLength = MAX_REQUEST_BODY_LENGTH,
): Promise<Readonly<Record<string, unknown>>> {
  let encoded: string;
  try {
    encoded = await readBoundedUtf8Body(request, maximumLength);
  } catch (cause) {
    if (cause instanceof RequestBodyError) {
      throw new PairingDirectoryError(
        "invalid_request",
        cause.code === "body_too_large"
          ? "The request body is too large"
          : "The request body is invalid",
        { cause },
      );
    }
    throw cause;
  }
  if (encoded.length === 0) {
    throw new PairingDirectoryError(
      "invalid_request",
      "The request body is invalid",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch (cause) {
    throw new PairingDirectoryError(
      "invalid_request",
      "The request body is not valid JSON",
      { cause },
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

function readString(
  value: Readonly<Record<string, unknown>>,
  key: string,
  maximumLength = 128,
  allowEmpty = false,
): string {
  const field = value[key];
  if (
    typeof field !== "string" ||
    field.length > maximumLength ||
    (!allowEmpty && field.length === 0)
  ) {
    throw new PairingDirectoryError(
      "invalid_request",
      `The ${key} field is invalid`,
    );
  }
  return field;
}

function readInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new PairingDirectoryError(
      "invalid_request",
      `The ${key} field is invalid`,
    );
  }
  return field;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    throw new PairingDirectoryError(
      "unauthorized",
      "A project bearer token is required",
    );
  }
  return authorization.slice("Bearer ".length);
}

function pageLimit(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  if (!/^\d+$/.test(value)) {
    throw new SessionRuntimeError(
      "invalid_page_size",
      "The page size is invalid",
    );
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new SessionRuntimeError(
      "invalid_page_size",
      `The page size must be between 1 and ${MAX_PAGE_SIZE.toString()}`,
    );
  }
  return limit;
}

function optionalCursor(value: string | undefined): string | null {
  return value ?? null;
}

function reportUnexpectedError(error: unknown): void {
  console.error("Mobius relay request failed", error);
}

function preserveCancellation(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) {
    throw error;
  }
}

function directoryError(error: unknown): Response {
  if (error instanceof PairingDirectoryError) {
    const status =
      error.code === "pairing_not_found" || error.code === "channel_not_found"
        ? 404
        : error.code === "unauthorized"
          ? 401
          : 400;
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
        message: "The authorization directory is unavailable",
      },
    },
    { status: 503 },
  );
}

function sessionError(error: unknown): Response {
  if (error instanceof PairingDirectoryError) {
    return directoryError(error);
  }
  if (error instanceof SessionRuntimeError) {
    const status =
      error.code === "session_not_found" || error.code === "artifact_not_found"
        ? 404
        : error.code === "session_access_denied"
          ? 403
          : error.code === "session_deleted" || error.code === "cursor_expired"
            ? 410
            : error.code === "session_quota_exceeded"
              ? 429
              : error.code === "session_busy" ||
                  error.code === "session_conflict"
                ? 409
                : error.code === "content_too_large"
                  ? 413
                  : error.code === "invalid_cursor" ||
                      error.code === "invalid_export" ||
                      error.code === "invalid_page_size"
                    ? 400
                    : 503;
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status },
    );
  }
  reportUnexpectedError(error);
  return Response.json(
    {
      error: {
        code: "session_storage_unavailable",
        message: "The session storage is unavailable",
      },
    },
    { status: 503 },
  );
}

async function projectScope(
  dependencies: RelayDependencies,
  projectId: string,
  request: Request,
): Promise<ProjectScope> {
  const access = await dependencies.pairingDirectory.authorizeProject(
    validateIdentifier(projectId, "project_id"),
    bearerToken(request),
    request.signal,
  );
  return new ProjectScope(access.tenantId, access.projectId);
}

function createRequest(
  body: Readonly<Record<string, unknown>>,
): CreateSessionRequest {
  assertExactKeys(body, [
    "agentId",
    "bindingId",
    "directoryId",
    "policy",
    "runtimeId",
    "sessionId",
    "title",
  ]);
  const policy = body["policy"];
  if (!isRecord(policy)) {
    throw new PairingDirectoryError(
      "invalid_request",
      "The session policy is invalid",
    );
  }
  assertExactKeys(policy, [
    "contentLimitBytes",
    "hotEventLimit",
    "level",
    "retentionMilliseconds",
  ]);
  const level = policy["level"];
  if (level !== "full" && level !== "summary") {
    throw new PairingDirectoryError(
      "invalid_request",
      "The session recording level is invalid",
    );
  }
  return new CreateSessionRequest(
    validateIdentifier(readString(body, "sessionId"), "session_id"),
    validateIdentifier(readString(body, "runtimeId"), "runtime_id"),
    validateIdentifier(readString(body, "agentId"), "agent_id"),
    validateIdentifier(readString(body, "bindingId"), "binding_id"),
    validateIdentifier(readString(body, "directoryId"), "directory_id"),
    new SessionRecordingPolicy(
      level,
      readInteger(policy, "retentionMilliseconds"),
      readInteger(policy, "hotEventLimit"),
      readInteger(policy, "contentLimitBytes"),
    ),
    readString(body, "title", 500, true),
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
      return context.json(
        await dependencies.pairingDirectory.createPairing(
          context.req.raw.signal,
        ),
        201,
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return directoryError(error);
    }
  });

  app.get("/v1/pairings/:pairingId", async (context) => {
    try {
      return context.json(
        await dependencies.pairingDirectory.readPairingStatus(
          validateIdentifier(context.req.param("pairingId"), "pairing_id"),
          context.req.query("token") ?? "",
          context.req.raw.signal,
        ),
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return directoryError(error);
    }
  });

  app.post("/v1/pairings/claim", async (context) => {
    try {
      const body = await parseJsonBody(context.req.raw);
      assertExactKeys(body, [
        "agents",
        "installableAgents",
        "machineName",
        "pairingCode",
        "workspaceName",
      ]);
      const agents = validateAgents(body["agents"]);
      const installableAgents = validateInstallableAgents(
        body["installableAgents"],
      );
      validateAgentCatalog(agents, installableAgents);
      return context.json(
        await dependencies.pairingDirectory.claimPairing(
          validatePairingCode(body["pairingCode"]),
          validateDisplayName(body["machineName"], "machine_name"),
          validateDisplayName(body["workspaceName"], "workspace_name"),
          agents,
          installableAgents,
          context.req.raw.signal,
        ),
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return directoryError(error);
    }
  });

  app.put("/v1/channels/:channelId/catalog", async (context) => {
    try {
      const body = await parseJsonBody(context.req.raw);
      assertExactKeys(body, ["agents", "installableAgents"]);
      const agents = validateAgents(body["agents"]);
      const installableAgents = validateInstallableAgents(
        body["installableAgents"],
      );
      validateAgentCatalog(agents, installableAgents);
      await dependencies.pairingDirectory.updateAgentCatalog(
        validateIdentifier(context.req.param("channelId"), "channel_id"),
        context.req.query("token") ?? "",
        agents,
        installableAgents,
        context.req.raw.signal,
      );
      return new Response(null, { status: 204 });
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return directoryError(error);
    }
  });

  app.get("/v1/channels/:channelId", async (context) => {
    try {
      return context.json(
        await dependencies.pairingDirectory.readChannel(
          validateIdentifier(context.req.param("channelId"), "channel_id"),
          context.req.query("token") ?? bearerToken(context.req.raw),
          context.req.raw.signal,
        ),
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return directoryError(error);
    }
  });

  app.get("/v1/channels/:channelId/host", async (context) => {
    try {
      const channelId = validateIdentifier(
        context.req.param("channelId"),
        "channel_id",
      );
      const access = await dependencies.pairingDirectory.authorizeHost(
        channelId,
        context.req.query("token") ?? "",
        context.req.raw.signal,
      );
      return await dependencies.channelRuntime.acceptHost(
        access,
        context.req.raw,
        context.req.raw.signal,
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return directoryError(error);
    }
  });

  app.get("/v1/channels/:channelId/daemon", async (context) => {
    try {
      const channelId = validateIdentifier(
        context.req.param("channelId"),
        "channel_id",
      );
      const access = await dependencies.pairingDirectory.authorizeDaemon(
        channelId,
        context.req.query("token") ?? "",
        context.req.raw.signal,
      );
      return await dependencies.channelRuntime.acceptDaemon(
        access,
        context.req.raw,
        context.req.raw.signal,
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return directoryError(error);
    }
  });

  app.post("/v1/projects/:projectId/sessions", async (context) => {
    try {
      const scope = await projectScope(
        dependencies,
        context.req.param("projectId"),
        context.req.raw,
      );
      const request = createRequest(await parseJsonBody(context.req.raw));
      return context.json(
        await dependencies.sessionRuntime.createSession(
          scope,
          request,
          Date.now(),
          context.req.raw.signal,
        ),
        201,
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return sessionError(error);
    }
  });

  app.get("/v1/projects/:projectId/sessions", async (context) => {
    try {
      const scope = await projectScope(
        dependencies,
        context.req.param("projectId"),
        context.req.raw,
      );
      return context.json(
        await dependencies.sessionRuntime.listSessions(
          scope,
          optionalCursor(context.req.query("cursor")),
          pageLimit(context.req.query("limit")),
          context.req.raw.signal,
        ),
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return sessionError(error);
    }
  });

  app.post("/v1/projects/:projectId/session-imports", async (context) => {
    try {
      const scope = await projectScope(
        dependencies,
        context.req.param("projectId"),
        context.req.raw,
      );
      const body = await parseJsonBody(context.req.raw, MAX_IMPORT_BODY_LENGTH);
      assertExactKeys(body, ["export"]);
      return context.json(
        await dependencies.sessionRuntime.importSession(
          scope,
          body["export"],
          Date.now(),
          context.req.raw.signal,
        ),
        201,
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return sessionError(error);
    }
  });

  app.get("/v1/projects/:projectId/sessions/:sessionId", async (context) => {
    try {
      const scope = await projectScope(
        dependencies,
        context.req.param("projectId"),
        context.req.raw,
      );
      return context.json(
        await dependencies.sessionRuntime.readSession(
          scope,
          validateIdentifier(context.req.param("sessionId"), "session_id"),
          context.req.raw.signal,
        ),
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return sessionError(error);
    }
  });

  app.put(
    "/v1/projects/:projectId/sessions/:sessionId/binding",
    async (context) => {
      try {
        const scope = await projectScope(
          dependencies,
          context.req.param("projectId"),
          context.req.raw,
        );
        const body = await parseJsonBody(context.req.raw);
        assertExactKeys(body, ["runtimeId"]);
        return context.json(
          await dependencies.sessionRuntime.bindSession(
            scope,
            validateIdentifier(context.req.param("sessionId"), "session_id"),
            validateIdentifier(readString(body, "runtimeId"), "runtime_id"),
            context.req.raw.signal,
          ),
        );
      } catch (error) {
        preserveCancellation(context.req.raw.signal, error);
        return sessionError(error);
      }
    },
  );

  app.get(
    "/v1/projects/:projectId/sessions/:sessionId/messages",
    async (context) => {
      try {
        const scope = await projectScope(
          dependencies,
          context.req.param("projectId"),
          context.req.raw,
        );
        return context.json(
          await dependencies.sessionRuntime.readMessages(
            scope,
            validateIdentifier(context.req.param("sessionId"), "session_id"),
            optionalCursor(context.req.query("cursor")),
            pageLimit(context.req.query("limit")),
            context.req.raw.signal,
          ),
        );
      } catch (error) {
        preserveCancellation(context.req.raw.signal, error);
        return sessionError(error);
      }
    },
  );

  app.get(
    "/v1/projects/:projectId/sessions/:sessionId/events",
    async (context) => {
      try {
        const scope = await projectScope(
          dependencies,
          context.req.param("projectId"),
          context.req.raw,
        );
        return context.json(
          await dependencies.sessionRuntime.readEvents(
            scope,
            validateIdentifier(context.req.param("sessionId"), "session_id"),
            optionalCursor(context.req.query("cursor")),
            pageLimit(context.req.query("limit")),
            context.req.raw.signal,
          ),
        );
      } catch (error) {
        preserveCancellation(context.req.raw.signal, error);
        return sessionError(error);
      }
    },
  );

  app.get(
    "/v1/projects/:projectId/sessions/:sessionId/activities/:activityId",
    async (context) => {
      try {
        const scope = await projectScope(
          dependencies,
          context.req.param("projectId"),
          context.req.raw,
        );
        return context.json(
          await dependencies.sessionRuntime.readActivityDetail(
            scope,
            validateIdentifier(context.req.param("sessionId"), "session_id"),
            validateIdentifier(context.req.param("activityId"), "activity_id"),
            context.req.raw.signal,
          ),
        );
      } catch (error) {
        preserveCancellation(context.req.raw.signal, error);
        return sessionError(error);
      }
    },
  );

  app.get(
    "/v1/projects/:projectId/sessions/:sessionId/export",
    async (context) => {
      try {
        const scope = await projectScope(
          dependencies,
          context.req.param("projectId"),
          context.req.raw,
        );
        return context.json(
          await dependencies.sessionRuntime.exportSession(
            scope,
            validateIdentifier(context.req.param("sessionId"), "session_id"),
            context.req.raw.signal,
          ),
        );
      } catch (error) {
        preserveCancellation(context.req.raw.signal, error);
        return sessionError(error);
      }
    },
  );

  app.delete("/v1/projects/:projectId/sessions/:sessionId", async (context) => {
    try {
      const scope = await projectScope(
        dependencies,
        context.req.param("projectId"),
        context.req.raw,
      );
      return context.json(
        await dependencies.sessionRuntime.deleteSession(
          scope,
          validateIdentifier(context.req.param("sessionId"), "session_id"),
          Date.now(),
          context.req.raw.signal,
        ),
      );
    } catch (error) {
      preserveCancellation(context.req.raw.signal, error);
      return sessionError(error);
    }
  });

  return app;
}
