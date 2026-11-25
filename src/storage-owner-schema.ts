export const STORAGE_OWNER_DDL = `CREATE TABLE IF NOT EXISTS native_runtime_owner (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK(fence>0), lease_until INTEGER NOT NULL
)`;
