export type DoSqlValue = null | number | string | ArrayBuffer;
export type DoSqlRow = Readonly<Record<string, DoSqlValue>>;

export interface DoSqlDatabase {
    readonly exec: (script: string) => void;
    readonly query: (sql: string, values?: readonly DoSqlValue[]) => readonly DoSqlRow[];
    readonly run: (sql: string, values?: readonly DoSqlValue[]) => { readonly changes: number };
    readonly transaction: <T>(operation: () => T) => T;
}
