import { randomUUID, createHmac } from "node:crypto";
import type { PoolClient } from "pg";
import type { PostgresStore } from "../db/postgres";
import { createAudit } from "../domain/apply";
import { saveAudit } from "../db/postgres-write";
import { NOTIFICATION_WORKER } from "../security/actors";

export const enqueueNotification = async (
  client: PoolClient,
  incidentId: string,
  text: string,
  adapter = "journal",
) => {
  await client.query(
    "INSERT INTO notification_jobs(id,incident_id,adapter,payload) VALUES($1,$2,$3,$4) ON CONFLICT(incident_id,adapter) DO NOTHING",
    [randomUUID(), incidentId, adapter, { incidentId, text }],
  );
};

export const deliverNotification = async (job: {
  id: string;
  adapter: string;
  payload: unknown;
}) => {
  if (
    job.adapter === "journal" ||
    job.adapter.startsWith("runbook:") ||
    process.env.NOTIFICATION_DELIVERY !== "enabled"
  )
    return { dryRun: true };
  if (job.adapter !== "webhook")
    throw new Error("Unknown notification adapter");
  const endpoint = new URL(process.env.NOTIFICATION_WEBHOOK_URL ?? "");
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
    throw new Error("Webhook requires a configured HTTPS endpoint");
  const body = JSON.stringify(job.payload);
  const secret = process.env.NOTIFICATION_WEBHOOK_SECRET;
  if (!secret) throw new Error("Webhook signing secret required");
  const response = await fetch(endpoint, {
    method: "POST",
    body,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: {
      "content-type": "application/json",
      "idempotency-key": job.id,
      "x-sentinel-signature": createHmac("sha256", secret)
        .update(body)
        .digest("hex"),
    },
  });
  // Drain is best-effort — never override HTTP outcome after the request already completed.
  try {
    await response.body?.cancel();
  } catch {
    /* ignore */
  }
  if (!response.ok) throw new Error(`Webhook HTTP ${response.status}`);
  return { dryRun: false };
};

const settleSentWithAudit = async (
  store: PostgresStore,
  job: { id: string; dryRun: boolean | null },
  fromStates: string[],
) => {
  await store.transaction(async (client) => {
    const updated = await client.query(
      `UPDATE notification_jobs SET state='sent',completed_at=COALESCE(completed_at,now()),lease_until=NULL,lease_token=NULL,error=NULL
       WHERE id=$1 AND state = ANY($2::text[])`,
      [job.id, fromStates],
    );
    if (!updated.rowCount) return;
    await saveAudit(client, [
      createAudit(
        `Notification ${job.id} ${job.dryRun === null ? "delivery completed (legacy mode unknown)" : job.dryRun ? "recorded (dry run)" : "delivered"}`,
        NOTIFICATION_WORKER,
      ),
    ]);
  });
};

export const notificationTick = async (store: PostgresStore) => {
  const job = await store.transaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      adapter: string;
      payload: unknown;
      attempts: number;
      state: string;
      delivery_dry_run: boolean | null;
    }>(`SELECT id,adapter,payload,attempts,state,delivery_dry_run FROM notification_jobs
      WHERE (state='pending' AND available_at<=now())
         OR (state='sending' AND lease_until<now())
         OR (state='audit_pending' AND available_at<=now())
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    if (!rows[0]) return;
    if (rows[0].state === "audit_pending") {
      // Reserve reconciliation before releasing the lock; a failed audit cannot starve deliveries.
      await client.query(
        "UPDATE notification_jobs SET available_at=now()+interval '30 seconds' WHERE id=$1",
        [rows[0].id],
      );
      return {
        ...rows[0],
        attempts: rows[0].attempts,
        lease: null as string | null,
        auditOnly: true as const,
      };
    }
    if (rows[0].attempts >= 5) {
      await client.query(
        "UPDATE notification_jobs SET state='failed',error='Delivery budget exhausted',lease_until=NULL,lease_token=NULL WHERE id=$1",
        [rows[0].id],
      );
      return;
    }
    const lease = randomUUID();
    await client.query(
      "UPDATE notification_jobs SET state='sending',attempts=attempts+1,lease_until=now()+interval '30 seconds',lease_token=$2 WHERE id=$1",
      [rows[0].id, lease],
    );
    return {
      ...rows[0],
      attempts: rows[0].attempts + 1,
      lease,
      auditOnly: false as const,
    };
  });
  if (!job) return;
  if (job.auditOnly) {
    const dryRun = job.delivery_dry_run;
    try {
      await settleSentWithAudit(store, { id: job.id, dryRun }, [
        "audit_pending",
      ]);
    } catch (error) {
      await store.pool.query(
        "UPDATE notification_jobs SET error=$2 WHERE id=$1 AND state='audit_pending'",
        [
          job.id,
          error instanceof Error
            ? error.message
            : "Audit reconciliation failed",
        ],
      );
      throw error;
    }
    return;
  }
  try {
    const result = await deliverNotification(job);
    try {
      await settleSentWithAudit(
        store,
        { id: job.id, dryRun: result.dryRun },
        // A successful delivery wins even if another lease has already failed.
        ["sending", "pending", "failed"],
      );
    } catch (settleError) {
      // Delivery already happened — retry audit later without re-sending.
      await store.pool
        .query(
          `UPDATE notification_jobs SET state='audit_pending',completed_at=now(),lease_until=NULL,lease_token=NULL,error=$2,delivery_dry_run=$3,available_at=now()
           WHERE id=$1 AND state IN ('sending','pending','failed')`,
          [
            job.id,
            settleError instanceof Error
              ? settleError.message
              : "Settle failed after delivery",
            result.dryRun,
          ],
        )
        .catch(() => undefined);
    }
  } catch (error) {
    // Delivery failed only — settle/force-sent errors must not reach here.
    await store.pool.query(
      "UPDATE notification_jobs SET state=$2,available_at=now()+($3*interval '1 second'),error=$4,lease_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$5 AND state='sending'",
      [
        job.id,
        job.attempts >= 5 ? "failed" : "pending",
        Math.min(300, 2 ** job.attempts),
        error instanceof Error ? error.message : "Delivery failed",
        job.lease,
      ],
    );
  }
};
