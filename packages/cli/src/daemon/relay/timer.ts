export interface ScheduledTask {
    readonly cancel: () => void;
}

export interface Timer {
    readonly schedule: (callback: () => void, milliseconds: number) => ScheduledTask;
}

class SystemTimer implements Timer {
    readonly schedule = (callback: () => void, milliseconds: number): ScheduledTask => {
        const timeout = setTimeout(callback, milliseconds);
        return {
            cancel: () => {
                clearTimeout(timeout);
            },
        };
    };
}

export const systemTimer: Timer = new SystemTimer();
