export type MigrationRow = Record<string, unknown>

export interface SqliteStatement {
  run(values: Record<string, unknown>): unknown
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement
  transaction<Row>(callback: (rows: readonly Row[]) => void): (rows: readonly Row[]) => unknown
}

export interface MigrationAdapter<Row = MigrationRow> {
  name: string
  sourceFile: string
  insert(sqlite: SqliteDatabase, rows: readonly Row[]): number
}
