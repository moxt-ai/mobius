export interface BotGrantCredential {
    readonly audience: string;
    readonly bot_id: string;
    readonly expires_at: number;
    readonly label: string;
    readonly project_id: string;
    readonly scopes_json: string;
}
