import type {
  AgentInstallationStage,
  AgentInstallRequestCommand,
} from "@moxt-ai/mobius-protocol";

import type { LocalAgentSpecification } from "../agent-catalog/agent-specification.ts";

const INSTALLATION_DEADLINE_MILLISECONDS = 10 * 60 * 1_000;

export abstract class AgentInstallation {
  readonly agentId: string;
  readonly requestId: string;
  abstract readonly status: string;

  protected constructor(requestId: string, agentId: string) {
    this.agentId = agentId;
    this.requestId = requestId;
  }
}

export class RequestedInstallation extends AgentInstallation {
  readonly status = "requested";

  constructor(requestId: string, agentId: string) {
    super(requestId, agentId);
  }
}

export class AwaitingLocalApproval extends AgentInstallation {
  readonly status = "awaiting_local_approval";

  constructor(requestId: string, agentId: string) {
    super(requestId, agentId);
  }
}

export class RunningInstallation extends AgentInstallation {
  readonly stage: AgentInstallationStage;
  readonly status = "running";

  constructor(
    requestId: string,
    agentId: string,
    stage: AgentInstallationStage,
  ) {
    super(requestId, agentId);
    this.stage = stage;
  }
}

export class SucceededInstallation extends AgentInstallation {
  readonly authenticationMayBeRequired = true;
  readonly status = "succeeded";

  constructor(requestId: string, agentId: string) {
    super(requestId, agentId);
  }
}

export class FailedInstallation extends AgentInstallation {
  readonly code: string;
  readonly message: string;
  readonly status = "failed";

  constructor(
    requestId: string,
    agentId: string,
    code: string,
    message: string,
  ) {
    super(requestId, agentId);
    this.code = code;
    this.message = message;
  }
}

export class CancelledInstallation extends AgentInstallation {
  readonly status = "cancelled";

  constructor(requestId: string, agentId: string) {
    super(requestId, agentId);
  }
}

export class InstallationManagerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.code = code;
    this.name = "InstallationManagerError";
  }
}

export interface InstallationAuthorizer {
  readonly authorize: (
    agentId: string,
    label: string,
    requestId: string,
    signal: AbortSignal,
  ) => Promise<boolean>;
}

export interface InstallationExecutor {
  readonly execute: (
    agentId: string,
    requestId: string,
    report: (stage: AgentInstallationStage) => Promise<void>,
    signal: AbortSignal,
  ) => Promise<void>;
}

export interface InstallationObserver {
  readonly onState: (state: AgentInstallation) => Promise<void>;
}

export interface InstallationAudit {
  readonly record: (
    event: string,
    requestId: string,
    agentId: string,
    details?: Readonly<Record<string, string>>,
  ) => void;
}

class NullInstallationAudit implements InstallationAudit {
  readonly record = (): void => undefined;
}

class InstallationJob {
  readonly agentId: string;
  readonly completion = Promise.withResolvers<AgentInstallation>();
  readonly controller = new AbortController();
  readonly requestId: string;
  state: AgentInstallation;

  constructor(requestId: string, agentId: string) {
    this.agentId = agentId;
    this.requestId = requestId;
    this.state = new RequestedInstallation(requestId, agentId);
  }
}

function specificationFor(
  specifications: readonly LocalAgentSpecification[],
  agentId: string,
): LocalAgentSpecification | null {
  for (const specification of specifications) {
    if (specification.id === agentId) {
      return specification;
    }
  }
  return null;
}

function executionFailure(error: unknown): InstallationManagerError {
  if (error instanceof InstallationManagerError) {
    return error;
  }
  return new InstallationManagerError(
    "installation_failed",
    "The local Agent installation failed",
    { cause: error },
  );
}

export class AgentInstallationManager {
  readonly #activeAgents = new Map<string, string>();
  readonly #audit: InstallationAudit;
  readonly #authorizer: InstallationAuthorizer;
  readonly #executor: InstallationExecutor;
  readonly #jobs = new Map<string, InstallationJob>();
  readonly #observer: InstallationObserver;
  readonly #specifications: readonly LocalAgentSpecification[];

  constructor(
    specifications: readonly LocalAgentSpecification[],
    authorizer: InstallationAuthorizer,
    executor: InstallationExecutor,
    observer: InstallationObserver,
    audit: InstallationAudit = new NullInstallationAudit(),
  ) {
    this.#audit = audit;
    this.#authorizer = authorizer;
    this.#executor = executor;
    this.#observer = observer;
    this.#specifications = Object.freeze([...specifications]);
  }

  readonly request = async (
    command: AgentInstallRequestCommand,
    signal: AbortSignal,
  ): Promise<AgentInstallation> => {
    const existing = this.#jobs.get(command.requestId);
    if (existing !== undefined) {
      if (existing.agentId !== command.agentId) {
        const conflict = new FailedInstallation(
          command.requestId,
          command.agentId,
          "installation_request_conflict",
          "The installation request identifier is already in use",
        );
        this.#audit.record(
          "agent_installation_failed_installation_request_conflict",
          command.requestId,
          command.agentId,
        );
        await this.#observer.onState(conflict);
        return conflict;
      }
      await this.#observer.onState(existing.state);
      return await existing.completion.promise;
    }

    this.#audit.record(
      "agent_installation_requested",
      command.requestId,
      command.agentId,
    );

    const specification = specificationFor(
      this.#specifications,
      command.agentId,
    );
    if (specification === null) {
      const unknown = new FailedInstallation(
        command.requestId,
        command.agentId,
        "unknown_agent",
        "The requested Agent is not supported",
      );
      const job = new InstallationJob(command.requestId, command.agentId);
      job.state = unknown;
      job.completion.resolve(unknown);
      this.#jobs.set(command.requestId, job);
      this.#audit.record(
        "agent_installation_failed_unknown_agent",
        command.requestId,
        command.agentId,
      );
      await this.#observer.onState(unknown);
      return unknown;
    }
    if (this.#activeAgents.has(command.agentId)) {
      const busy = new FailedInstallation(
        command.requestId,
        command.agentId,
        "installation_in_progress",
        "An installation for this Agent is already running",
      );
      const job = new InstallationJob(command.requestId, command.agentId);
      job.state = busy;
      job.completion.resolve(busy);
      this.#jobs.set(command.requestId, job);
      this.#audit.record(
        "agent_installation_failed_installation_in_progress",
        command.requestId,
        command.agentId,
      );
      await this.#observer.onState(busy);
      return busy;
    }

    const job = new InstallationJob(command.requestId, command.agentId);
    this.#jobs.set(command.requestId, job);
    this.#activeAgents.set(command.agentId, command.requestId);
    void this.#run(job, specification, signal);
    return await job.completion.promise;
  };

  readonly cancel = async (requestId: string): Promise<AgentInstallation> => {
    const job = this.#jobs.get(requestId);
    if (job === undefined) {
      throw new InstallationManagerError(
        "installation_not_found",
        "The installation request was not found",
      );
    }
    if (
      job.state instanceof SucceededInstallation ||
      job.state instanceof FailedInstallation ||
      job.state instanceof CancelledInstallation
    ) {
      await this.#observer.onState(job.state);
      return job.state;
    }
    this.#audit.record(
      "agent_installation_cancellation_requested",
      job.requestId,
      job.agentId,
    );
    job.controller.abort(new Error("Agent installation cancelled"));
    return await job.completion.promise;
  };

  readonly close = async (): Promise<void> => {
    const completions: Promise<AgentInstallation>[] = [];
    for (const requestId of this.#activeAgents.values()) {
      const job = this.#jobs.get(requestId);
      if (job === undefined) {
        throw new InstallationManagerError(
          "installation_state_invalid",
          "An active Agent installation is unavailable",
        );
      }
      job.controller.abort(new Error("Mobius daemon stopped"));
      completions.push(job.completion.promise);
    }
    await Promise.all(completions);
  };

  readonly #transition = async (
    job: InstallationJob,
    state: AgentInstallation,
  ): Promise<void> => {
    job.state = state;
    await this.#observer.onState(state);
  };

  readonly #run = async (
    job: InstallationJob,
    specification: LocalAgentSpecification,
    externalSignal: AbortSignal,
  ): Promise<void> => {
    const abort = (): void => job.controller.abort(externalSignal.reason);
    externalSignal.addEventListener("abort", abort, { once: true });
    if (externalSignal.aborted) {
      abort();
    }
    const deadline = setTimeout(() => {
      job.controller.abort(
        new InstallationManagerError(
          "installation_timeout",
          "The local Agent installation exceeded its deadline",
        ),
      );
    }, INSTALLATION_DEADLINE_MILLISECONDS);
    const signal = job.controller.signal;
    try {
      await this.#transition(
        job,
        new AwaitingLocalApproval(job.requestId, job.agentId),
      );
      this.#audit.record(
        "agent_installation_awaiting_approval",
        job.requestId,
        job.agentId,
      );
      const approved = await this.#authorizer.authorize(
        specification.id,
        specification.label,
        job.requestId,
        signal,
      );
      signal.throwIfAborted();
      if (!approved) {
        const denied = new FailedInstallation(
          job.requestId,
          job.agentId,
          "installation_not_authorized",
          "Installation was not approved on the local machine",
        );
        await this.#transition(job, denied);
        this.#audit.record(
          "agent_installation_denied",
          job.requestId,
          job.agentId,
        );
        job.completion.resolve(denied);
        return;
      }
      this.#audit.record(
        "agent_installation_authorized",
        job.requestId,
        job.agentId,
      );
      await this.#executor.execute(
        job.agentId,
        job.requestId,
        async (stage) => {
          signal.throwIfAborted();
          await this.#transition(
            job,
            new RunningInstallation(job.requestId, job.agentId, stage),
          );
          this.#audit.record(
            `agent_installation_${stage}`,
            job.requestId,
            job.agentId,
          );
        },
        signal,
      );
      signal.throwIfAborted();
      const succeeded = new SucceededInstallation(job.requestId, job.agentId);
      await this.#transition(job, succeeded);
      this.#audit.record(
        "agent_installation_completed",
        job.requestId,
        job.agentId,
      );
      job.completion.resolve(succeeded);
    } catch (error) {
      if (signal.aborted) {
        if (
          signal.reason instanceof InstallationManagerError &&
          signal.reason.code === "installation_timeout"
        ) {
          const timedOut = new FailedInstallation(
            job.requestId,
            job.agentId,
            signal.reason.code,
            signal.reason.message,
          );
          await this.#transition(job, timedOut);
          this.#audit.record(
            "agent_installation_failed_installation_timeout",
            job.requestId,
            job.agentId,
          );
          job.completion.resolve(timedOut);
          return;
        }
        const cancelled = new CancelledInstallation(job.requestId, job.agentId);
        await this.#transition(job, cancelled);
        this.#audit.record(
          "agent_installation_cancelled",
          job.requestId,
          job.agentId,
        );
        job.completion.resolve(cancelled);
      } else {
        const failure = executionFailure(error);
        const failed = new FailedInstallation(
          job.requestId,
          job.agentId,
          failure.code,
          failure.message,
        );
        await this.#transition(job, failed);
        this.#audit.record(
          `agent_installation_failed_${failure.code}`,
          job.requestId,
          job.agentId,
        );
        job.completion.resolve(failed);
      }
    } finally {
      clearTimeout(deadline);
      externalSignal.removeEventListener("abort", abort);
      if (this.#activeAgents.get(job.agentId) === job.requestId) {
        this.#activeAgents.delete(job.agentId);
      }
    }
  };
}
