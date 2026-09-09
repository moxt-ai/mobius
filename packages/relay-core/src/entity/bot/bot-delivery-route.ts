export interface BotDeliveryRoute {
    readonly alias: string;
    readonly botId: string;
    readonly connectionId: string;
    readonly deliveryTargetId: string;
    readonly policyRevision: number;
}
