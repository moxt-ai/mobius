export interface DaemonScheduledTask {
    readonly cancel: () => void;
}

export interface DaemonTimer {
    readonly schedule: (callback: () => void, milliseconds: number) => DaemonScheduledTask;
}

class SystemDaemonTimer implements DaemonTimer {
    readonly schedule = (callback: () => void, milliseconds: number): DaemonScheduledTask => {
        const timeout = setTimeout(callback, milliseconds);
        return { cancel: () => clearTimeout(timeout) };
    };
}

export const systemDaemonTimer: DaemonTimer = new SystemDaemonTimer();
