import {
  type AgentDescriptor,
  ChannelDescriptor,
  type ClaimedPairing,
  type CreatedPairing,
  createRandomPairingCode,
  createRandomToken,
  ExpiredPairingStatus,
  hashSecret,
  normalizePairingCode,
  PAIRING_LIFETIME_MILLISECONDS,
  PairedPairingStatus,
  type PairingDirectory,
  PairingDirectoryError,
  type PairingStatus,
  PendingPairingStatus,
  parseAgents,
  validateToken,
} from "@moxt-ai/mobius-relay-core";

interface PairingChannelRow {
  readonly agents_json: string;
  readonly channel_id: string;
  readonly expires_at: number;
  readonly machine_name: string;
  readonly status: string;
  readonly workspace_name: string;
}

interface ClaimedChannelRow {
  readonly channel_id: string;
}

interface PublicChannelRow {
  readonly agents_json: string;
  readonly channel_id: string;
  readonly machine_name: string;
  readonly workspace_name: string;
}

export class D1PairingDirectory implements PairingDirectory {
  private readonly database: D1Database;

  constructor(database: D1Database) {
    this.database = database;
  }

  readonly authorizeDaemon = async (
    channelId: string,
    token: string,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const tokenHash = await hashSecret(validateToken(token));
    signal.throwIfAborted();
    const row = await this.database
      .prepare(
        `SELECT channel_id FROM pairing_channels
         WHERE channel_id = ? AND daemon_token_hash = ? AND status = 'paired'`,
      )
      .bind(channelId, tokenHash)
      .first<ClaimedChannelRow>();
    signal.throwIfAborted();
    if (row === null) {
      throw new PairingDirectoryError(
        "unauthorized",
        "A valid channel token is required",
      );
    }
    if (row.channel_id !== channelId) {
      throw new PairingDirectoryError(
        "invalid_directory_record",
        "The channel directory is invalid",
      );
    }
  };

  readonly authorizeHost = async (
    channelId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    await this.readChannel(channelId, signal);
  };

  readonly claimPairing = async (
    pairingCode: string,
    machineName: string,
    workspaceName: string,
    agents: readonly AgentDescriptor[],
    signal: AbortSignal,
  ): Promise<ClaimedPairing> => {
    signal.throwIfAborted();
    const daemonToken = createRandomToken(32);
    const now = Date.now();
    const claimed = await this.database
      .prepare(
        `UPDATE pairing_channels
         SET status = 'paired',
             daemon_token_hash = ?,
             claimed_at = ?,
             machine_name = ?,
             workspace_name = ?,
             agents_json = ?
         WHERE pairing_code_hash = ?
           AND status = 'pending'
           AND expires_at > ?
         RETURNING channel_id`,
      )
      .bind(
        await hashSecret(daemonToken),
        now,
        machineName,
        workspaceName,
        JSON.stringify(agents),
        await hashSecret(normalizePairingCode(pairingCode)),
        now,
      )
      .first<ClaimedChannelRow>();
    signal.throwIfAborted();

    if (claimed === null) {
      throw new PairingDirectoryError(
        "invalid_pairing_code",
        "The pairing code is invalid or expired",
      );
    }
    return { channelId: claimed.channel_id, daemonToken };
  };

  readonly createPairing = async (
    signal: AbortSignal,
  ): Promise<CreatedPairing> => {
    signal.throwIfAborted();
    const now = Date.now();
    const pairingId = crypto.randomUUID();
    const pairingCode = createRandomPairingCode();
    const pollToken = createRandomToken(32);
    const disabledBrowserToken = createRandomToken(32);
    const channelId = `chn_${createRandomToken(18)}`;
    const expiresAt = now + PAIRING_LIFETIME_MILLISECONDS;

    await this.database
      .prepare(
        `INSERT INTO pairing_channels (
          pairing_id,
          pairing_code_hash,
          poll_token_hash,
          channel_id,
          host_token_hash,
          status,
          created_at,
          expires_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(
        pairingId,
        await hashSecret(pairingCode),
        await hashSecret(pollToken),
        channelId,
        await hashSecret(disabledBrowserToken),
        now,
        expiresAt,
      )
      .run();
    signal.throwIfAborted();

    return {
      channelId,
      expiresAt: new Date(expiresAt).toISOString(),
      pairingCode,
      pairingId,
      pollToken,
    };
  };

  readonly readChannel = async (
    channelId: string,
    signal: AbortSignal,
  ): Promise<ChannelDescriptor> => {
    signal.throwIfAborted();
    const row = await this.database
      .prepare(
        `SELECT channel_id, machine_name, workspace_name, agents_json
         FROM pairing_channels
         WHERE channel_id = ? AND status = 'paired'`,
      )
      .bind(channelId)
      .first<PublicChannelRow>();
    signal.throwIfAborted();
    if (row === null) {
      throw new PairingDirectoryError(
        "channel_not_found",
        "The channel was not found",
      );
    }
    if (row.channel_id !== channelId) {
      throw new PairingDirectoryError(
        "invalid_directory_record",
        "The channel directory is invalid",
      );
    }
    return new ChannelDescriptor(
      parseAgents(row.agents_json),
      row.channel_id,
      row.machine_name,
      row.workspace_name,
    );
  };

  readonly readPairingStatus = async (
    pairingId: string,
    pollToken: string,
    signal: AbortSignal,
  ): Promise<PairingStatus> => {
    signal.throwIfAborted();
    const row = await this.database
      .prepare(
        `SELECT status, channel_id, expires_at, machine_name, workspace_name, agents_json
         FROM pairing_channels
         WHERE pairing_id = ? AND poll_token_hash = ?`,
      )
      .bind(pairingId, await hashSecret(pollToken))
      .first<PairingChannelRow>();
    signal.throwIfAborted();

    if (row === null) {
      throw new PairingDirectoryError(
        "pairing_not_found",
        "The pairing request was not found",
      );
    }
    if (row.status === "paired") {
      return new PairedPairingStatus(
        parseAgents(row.agents_json),
        row.channel_id,
        row.machine_name,
        row.workspace_name,
      );
    }
    if (row.status !== "pending") {
      throw new PairingDirectoryError(
        "invalid_directory_record",
        "The pairing status is invalid",
      );
    }
    if (row.expires_at <= Date.now()) {
      return new ExpiredPairingStatus();
    }
    return new PendingPairingStatus(new Date(row.expires_at).toISOString());
  };
}
