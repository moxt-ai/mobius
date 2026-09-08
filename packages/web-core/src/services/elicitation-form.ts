import type { SessionElicitationField } from "@moxt-ai/mobius-sdk";

export function encodeElicitationForm(form: FormData, fields: readonly SessionElicitationField[]): string {
    const values: Record<string, unknown> = {};
    for (const field of fields) {
        if (field.type === "boolean") {
            values[field.name] = form.has(field.name);
            continue;
        }
        if (field.type === "multiselect") {
            const selections = form.getAll(field.name).filter((value) => typeof value === "string");
            if (selections.length > 0 || field.required) {
                values[field.name] = selections;
            }
            continue;
        }
        const value = form.get(field.name);
        if (typeof value !== "string" || value.length === 0) {
            continue;
        }
        if (field.type === "integer" || field.type === "number") {
            values[field.name] = Number(value);
        } else {
            values[field.name] = value;
        }
    }
    return JSON.stringify(values);
}

export function readMultiselectDefaults(field: SessionElicitationField): readonly string[] {
    if (!field.hasDefaultValue || field.defaultStringValue.length === 0) {
        return [];
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(field.defaultStringValue);
    } catch {
        return [];
    }
    if (!Array.isArray(decoded)) {
        return [];
    }
    const allowed = new Set(field.options.map((option) => option.value));
    return decoded.filter((value) => typeof value === "string" && allowed.has(value));
}
