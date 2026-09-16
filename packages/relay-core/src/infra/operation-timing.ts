export interface OperationTiming {
    readonly measure: <T>(name: string, description: string, operation: () => Promise<T>) => Promise<T>;
    readonly record: (name: string, description: string, durationMilliseconds: number) => void;
}

export const unmeasuredOperationTiming: OperationTiming = {
    measure: async (_name, _description, operation) => await operation(),
    record: () => undefined,
};
