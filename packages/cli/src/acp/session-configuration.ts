import type { SessionConfigOption } from "@moxt-ai/mobius-sdk/protocol";
import { z } from "zod";

export type AcpStoredSessionConfiguration =
    | {
          readonly booleanValue: boolean;
          readonly configId: string;
          readonly type: "boolean";
      }
    | {
          readonly configId: string;
          readonly type: "select";
          readonly value: string;
      };

const storedSessionConfigurationsSchema = z
    .array(
        z.discriminatedUnion("type", [
            z.object({ booleanValue: z.boolean(), configId: z.string().max(128), type: z.literal("boolean") }),
            z.object({ configId: z.string().max(128), type: z.literal("select"), value: z.string().max(500) }),
        ]),
    )
    .max(100);

export const decodeStoredSessionConfigurations = (value: unknown): readonly AcpStoredSessionConfiguration[] =>
    storedSessionConfigurationsSchema.parse(value);

export type ApplyStoredSessionConfiguration = (
    configuration: AcpStoredSessionConfiguration,
    signal: AbortSignal,
) => Promise<void>;

export class AcpSessionConfigurations {
    #selected: readonly AcpStoredSessionConfiguration[] = [];

    readonly stored = (): readonly AcpStoredSessionConfiguration[] => this.#selected;

    readonly capture = (options: readonly SessionConfigOption[]): void => {
        this.#selected = this.#selected.map((selection) => {
            const current = options.find(
                (option) => option.id === selection.configId && option.type === selection.type,
            );
            if (current === undefined) {
                return selection;
            }
            return current.type === "boolean"
                ? { booleanValue: current.booleanValue, configId: current.id, type: "boolean" }
                : { configId: current.id, type: "select", value: current.currentValue };
        });
    };

    readonly select = (option: SessionConfigOption): void => {
        const selected: AcpStoredSessionConfiguration =
            option.type === "boolean"
                ? { booleanValue: option.booleanValue, configId: option.id, type: "boolean" }
                : { configId: option.id, type: "select", value: option.currentValue };
        this.#selected = [...this.#selected.filter((selection) => selection.configId !== selected.configId), selected];
    };

    readonly restore = async (
        stored: readonly AcpStoredSessionConfiguration[],
        options: readonly SessionConfigOption[],
        apply: ApplyStoredSessionConfiguration,
        signal: AbortSignal,
    ): Promise<void> => {
        this.#selected = stored;
        for (const selection of this.#selected) {
            const current = options.find(
                (option) => option.id === selection.configId && option.type === selection.type,
            );
            if (current === undefined) {
                continue;
            }
            if (selection.type === "boolean") {
                if (current.booleanValue !== selection.booleanValue) {
                    await apply(selection, signal);
                }
                continue;
            }
            if (
                current.currentValue !== selection.value &&
                current.values.some((value) => value.value === selection.value)
            ) {
                await apply(selection, signal);
            }
        }
    };
}
