import { writeFileSync, mkdirSync } from "node:fs";
import { readConfig } from "../server/config";
import { PostgresStore } from "../server/db/postgres";
const store = new PostgresStore(readConfig().databaseUrl);
try {
  const measurement = await store.transaction(async (client) => {
    await client.query(
      "CREATE TEMP TABLE analytics_probe ON COMMIT DROP AS SELECT n AS id, (n % 100)::int AS service, now()-(n*interval '1 second') AS at, (n % 1000)::float8 AS value FROM generate_series(1,100000) AS n",
    );
    await client.query("CREATE INDEX ON analytics_probe(at,service)");
    await client.query("ANALYZE analytics_probe");
    const samples: number[] = [];
    for (let i = 0; i < 12; i++) {
      const start = performance.now();
      await client.query(
        "SELECT service,avg(value),percentile_cont(0.95) WITHIN GROUP(ORDER BY value) FROM analytics_probe WHERE at>now()-interval '1 day' GROUP BY service",
      );
      if (i >= 2) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!;
    return {
      dataset: "synthetic, 100000 events, 100 services",
      runs: samples.length,
      p50Ms: samples[Math.floor(samples.length / 2)],
      p95Ms: p95,
      investigateClickHouse: p95 > 200,
      thresholdMs: 200,
    };
  });
  mkdirSync("benchmark-results", { recursive: true });
  writeFileSync(
    "benchmark-results/analytics.json",
    JSON.stringify({ at: new Date().toISOString(), ...measurement }, null, 2),
  );
  console.log(JSON.stringify(measurement));
} finally {
  await store.close();
}
