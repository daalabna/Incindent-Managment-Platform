import { Pool, type PoolClient } from "pg";
import type { IncidentPatch } from "../../shared/contracts";
import type {
  AuditEntry,
  Incident,
  MonitoringEvent,
  Rule,
} from "../../shared/domain";
import {
  createAudit,
  toSummary,
  type IncidentListStatus,
} from "../domain/apply";
import { deliveryReceipt } from "../domain/delivery";
import { migrateDatabase } from "./postgres-migrate";
import { beginDelivery, terminalDelivery, replayDelivery } from "./delivery";
import { traced } from "../observability/telemetry";
import { LOCAL_OPERATOR } from "../security/actors";
import {
  countProcessedEvents,
  countResolvedIncidents,
  listActivity,
  listIncidentPage,
  readEventStatus,
  readIncident,
  readSnapshot,
  readStats,
  readSummaryState,
} from "./postgres-read";
import { applyQueuedEvent } from "./postgres-ingest";
import {
  acceptEvent,
  addStoredRule,
  claimOutboxBatch,
  markOutboxFailed,
  markOutboxPublished,
  saveAudit,
  saveIncident,
  saveRule,
  toggleStoredRule,
  updateIncident,
} from "./postgres-write";
import { redact } from "../domain/errors";

export class PostgresStore {
  pool: Pool;
  constructor(
    url: string,
    private schema = "public",
  ) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema))
      throw new Error("Invalid database schema");
    this.pool = new Pool({
      connectionString: url,
      max: 10,
      options: `-c search_path=${schema}`,
      connectionTimeoutMillis: 3000,
      statement_timeout: 10000,
      idle_in_transaction_session_timeout: 15000,
    });
    this.pool.on("error", () => {
      /* Failed idle connections are discarded; readiness reports outages. */
    });
  }
  transaction = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> =>
    traced("postgres.transaction", async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  migrate = async () => {
    const found = await this.pool.query(
      "SELECT 1 FROM pg_namespace WHERE nspname=$1",
      [this.schema],
    );
    if (!found.rowCount)
      try {
        await this.pool.query(`CREATE SCHEMA "${this.schema}"`);
      } catch {
        throw new Error(
          `Schema ${this.schema} must be provisioned by a database administrator before startup`,
        );
      }
    return this.transaction(migrateDatabase);
  };
  snapshot = () => this.transaction(readSnapshot);
  summary = async () => {
    const [state, eventCount, resolvedCount] = await Promise.all([
      this.transaction(readSummaryState),
      countProcessedEvents(this.pool),
      countResolvedIncidents(this.pool),
    ]);
    return { ...toSummary(state), eventCount, resolvedCount };
  };
  incident = (id: string) => readIncident(this.pool, id);
  incidents = (
    limit: number,
    cursor?: string,
    status: IncidentListStatus = "all",
    q = "",
  ) => listIncidentPage(this.pool, limit, cursor, status, q);
  activity = (limit: number, offset = 0) =>
    listActivity(this.pool, limit, offset);
  accept = (event: MonitoringEvent) =>
    this.transaction((client) => acceptEvent(client, event));
  eventStatus = async (id: string) =>
    deliveryReceipt(id, await readEventStatus(this.pool, id), false);
  processEvent = (id: string) =>
    this.transaction((client) => applyQueuedEvent(client, id));
  beginDelivery = (id: string, generation: number) =>
    this.transaction((client) => beginDelivery(client, id, generation));
  /**
   * Durable path: commit attempt budget first, then process.
   * Two txns so attempts survive process failures; both take events advisory before row locks.
   */
  processDelivery = async (id: string, generation: number) => {
    const ready = await this.transaction((client) =>
      beginDelivery(client, id, generation),
    );
    if (!ready) return { skipped: true as const };
    if (ready === "terminal") return { terminal: true as const };
    return this.transaction((client) => applyQueuedEvent(client, id));
  };
  terminalDelivery = (id: string, generation: number | null, reason: string) =>
    this.transaction((client) =>
      terminalDelivery(client, id, generation, reason),
    );
  replay = (id: string, generation: number, actor: string, reason: string) =>
    this.transaction((client) =>
      replayDelivery(client, id, generation, actor, reason),
    );
  update = (
    id: string,
    version: number,
    patch: IncidentPatch,
    actor = LOCAL_OPERATOR,
  ) =>
    this.transaction((client) =>
      updateIncident(client, id, version, patch, actor),
    );
  writeIncident = (client: PoolClient, incident: Incident) =>
    saveIncident(client, incident);
  writeRule = (client: PoolClient, rule: Rule) => saveRule(client, rule);
  writeAudit = (client: PoolClient, entries: AuditEntry[]) =>
    saveAudit(client, entries);
  addRule = (rule: Omit<Rule, "id">, actor = LOCAL_OPERATOR) =>
    this.transaction((client) => addStoredRule(client, rule, actor));
  toggleRule = (id: string, enabled: boolean, actor = LOCAL_OPERATOR) =>
    this.transaction((client) => toggleStoredRule(client, id, enabled, actor));
  record = async (text: string, actor: string) => {
    const entry = createAudit(text, actor);
    await this.transaction((client) => this.writeAudit(client, [entry]));
  };
  publishPending = async (publish: (id: string) => Promise<void>) => {
    const notes: string[] = [];
    const batch = await this.transaction((client) => claimOutboxBatch(client));
    for (const row of batch) {
      try {
        await publish(row.event_id);
        await this.transaction((client) =>
          markOutboxPublished(client, row.sequence),
        );
      } catch (error) {
        const message = redact(
          error instanceof Error ? error.message : "Broker publish failed",
        );
        notes.push(`Outbox publish failed eventId=${row.event_id} ${message}`);
        await this.transaction((client) =>
          markOutboxFailed(client, row.sequence, message),
        );
        break;
      }
    }
    return notes;
  };
  stats = () => readStats(this.pool);
  close = () => this.pool.end();
}
