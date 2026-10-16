import type { HealthResponse, IncidentPatch } from "../../shared/contracts";
import type { MonitoringEvent, Rule } from "../../shared/domain";
import type { InfrastructureConfig } from "../config";
import { startDispatcher } from "./dispatcher";
import type { IncidentListStatus } from "../domain/apply";
import { PostgresStore } from "../db/postgres";
import { type ChangeNotice, RedisCoordinator } from "../broker/redis";
import { RabbitPipeline } from "../broker/rabbit";
import { startBackground } from "../operations/worker";
import { AiService } from "../ai/service";
import { AiQueue } from "../ai/queue";
import { readAiConfig } from "../ai/config";
import { startAiDispatcher } from "../ai/dispatcher";
import type { AnalysisProvider } from "../ai/provider";
import { LOCAL_OPERATOR } from "../security/actors";
import { changed, type Runtime } from "./runtime-types";
import { distributedHealth } from "./runtime-health";

export type { Runtime } from "./runtime-types";
export { localRuntime } from "./runtime-local";

export class DistributedRuntime implements Runtime {
  mode = "distributed" as const;
  store: PostgresStore;
  redis: RedisCoordinator;
  rabbit: RabbitPipeline;
  ai: AiService;
  private aiQueue?: AiQueue;
  private aiDispatcher?: ReturnType<typeof startAiDispatcher>;
  private dispatcher?: ReturnType<typeof startDispatcher>;
  private operations?: ReturnType<typeof startBackground>;
  private readonly background: boolean;
  constructor(
    config: InfrastructureConfig,
    private onChange: (notice: ChangeNotice) => void,
    private report: (message: string) => void,
    aiProvider?: AnalysisProvider,
  ) {
    this.background = config.embeddedWorker;
    this.store = new PostgresStore(config.databaseUrl, config.databaseSchema);
    this.ai = new AiService(
      this.store,
      config.ai ?? readAiConfig(),
      aiProvider,
    );
    if (this.ai.config.enabled)
      this.aiQueue = new AiQueue(config.namespace, this.ai.process, report);
    this.redis = new RedisCoordinator(config.redisUrl, config.namespace);
    this.rabbit = new RabbitPipeline(
      config.rabbitUrl,
      config.namespace,
      this.store,
      (notice) => this.changed(changed(notice.incidentId)),
      config.embeddedWorker,
      report,
      this.aiQueue,
    );
  }
  start = async () => {
    try {
      await this.store.migrate();
      await this.redis.start((notice) => this.onChange(notice));
      await this.rabbit.start();
      if (this.background) {
        if (this.aiQueue)
          this.aiDispatcher = startAiDispatcher(
            this.ai,
            this.aiQueue.publish,
            this.report,
          );
        this.operations = startBackground(this.store, this.report);
        this.dispatcher = startDispatcher(
          this.store,
          (id) => this.rabbit.publish(id),
          () => this.rabbit.connected,
          this.report,
        );
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  };
  private changed = async (notice: ChangeNotice) => {
    this.onChange(notice);
    await this.redis.notify(notice);
  };
  snapshot = () => this.store.snapshot();
  summary = () => this.store.summary();
  incident = (id: string) => this.store.incident(id);
  incidents = (
    limit: number,
    cursor?: string,
    status?: IncidentListStatus,
    q?: string,
  ) => this.store.incidents(limit, cursor, status, q);
  activity = (limit: number, offset?: number) =>
    this.store.activity(limit, offset);
  ingest = (event: MonitoringEvent) => this.store.accept(event);
  eventStatus = (id: string) => this.store.eventStatus(id);
  update = async (
    id: string,
    version: number,
    patch: IncidentPatch,
    actor = LOCAL_OPERATOR,
  ) => {
    const result = await this.store.update(id, version, patch, actor);
    await this.changed(changed(result.id));
    return result;
  };
  addRule = async (rule: Omit<Rule, "id">, actor = LOCAL_OPERATOR) => {
    const result = await this.store.addRule(rule, actor);
    await this.changed(changed());
    return result;
  };
  toggleRule = async (id: string, enabled: boolean, actor = LOCAL_OPERATOR) => {
    const result = await this.store.toggleRule(id, enabled, actor);
    await this.changed(changed());
    return result;
  };
  record = async (text: string, actor: string) => {
    await this.store.record(text, actor);
    await this.changed(changed());
  };
  acquireSimulation = () => this.redis.acquireSimulation();
  renewSimulation = (token: string) => this.redis.renewSimulation(token);
  releaseSimulation = (token: string) => this.redis.releaseSimulation(token);
  health = async (): Promise<HealthResponse> => {
    const [postgres, redis, rabbit] = await Promise.allSettled([
      this.store.stats(),
      this.redis.health(),
      this.rabbit.health(),
    ]);
    return distributedHealth(postgres, redis, rabbit);
  };
  close = async () => {
    await this.aiDispatcher?.stop();
    await this.operations?.stop();
    await this.dispatcher?.stop();
    await this.rabbit.close();
    await this.redis.close();
    await this.store.close();
  };
}
