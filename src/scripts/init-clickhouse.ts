import { initClickHouse } from "../clickhouse";

const ok = await initClickHouse();
console.log(ok ? "✓ ClickHouse schema ready (database sauron)" : "✗ ClickHouse not reachable — check .env");
process.exit(ok ? 0 : 1);
