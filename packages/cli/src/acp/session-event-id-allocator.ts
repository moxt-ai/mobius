export interface SessionEventIdAllocator {
    readonly allocate: (sessionId: string, sessionGenerationId: string) => string;
}

export class InMemorySessionEventIdAllocator implements SessionEventIdAllocator {
    readonly #allocations = new Map<string, { readonly nextId: number; readonly sessionGenerationId: string }>();

    readonly allocate = (sessionId: string, sessionGenerationId: string): string => {
        const current = this.#allocations.get(sessionId);
        const allocatedId =
            current === undefined || current.sessionGenerationId !== sessionGenerationId ? 1 : current.nextId;
        if (!Number.isSafeInteger(allocatedId)) {
            throw new Error("The Session event ID allocation is exhausted");
        }
        this.#allocations.set(sessionId, { nextId: allocatedId + 1, sessionGenerationId });
        return `event-${sessionGenerationId}-${allocatedId.toString().padStart(16, "0")}`;
    };
}
