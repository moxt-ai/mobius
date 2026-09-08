import type { WorkspaceEntry } from "@moxt-ai/mobius-sdk";

export function filterWorkspaceEntries(entries: readonly WorkspaceEntry[], query: string): readonly WorkspaceEntry[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
        return entries;
    }
    return entries.filter((entry) => entry.name.toLowerCase().includes(normalizedQuery));
}
