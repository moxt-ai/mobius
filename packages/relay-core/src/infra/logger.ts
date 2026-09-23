import pino from "pino";

export const logger = pino({
    base: { service: "mobius" },
    browser: { asObject: true },
    level: "info",
});
