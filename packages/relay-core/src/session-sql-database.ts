export type SessionSqlValue = null | number | string;
export type SessionSqlRow = Readonly<Record<string, SessionSqlValue>>;

export interface SessionSqlDatabase {
  readonly exec: (script: string) => void;
  readonly query: (
    sql: string,
    values?: readonly SessionSqlValue[],
  ) => readonly SessionSqlRow[];
  readonly run: (
    sql: string,
    values?: readonly SessionSqlValue[],
  ) => { readonly changes: number };
  readonly transaction: <T>(operation: () => T) => T;
}
