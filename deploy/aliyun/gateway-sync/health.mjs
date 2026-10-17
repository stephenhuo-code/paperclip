// Container healthcheck: the sync loop wrote its heartbeat in the last 2 minutes.
import fs from "node:fs";
try {
  const age = Date.now() - Number(fs.readFileSync("/tmp/gateway-sync-heartbeat", "utf8"));
  process.exit(age < 120_000 ? 0 : 1);
} catch {
  process.exit(1);
}
