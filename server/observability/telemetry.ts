import {
  context,
  propagation,
  trace,
  metrics,
  SpanStatusCode,
} from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { FastifyInstance } from "fastify";
let sdk: NodeSDK | undefined;
export const startTelemetry = () => {
  if (sdk || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME ?? "sentinel",
      "sentinel.tenant": process.env.TENANT_ID ?? "default",
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 10000,
    }),
  });
  sdk.start();
};
export const stopTelemetry = async () => {
  await sdk?.shutdown();
  sdk = undefined;
};
export const traceHeaders = () => {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
};
export const traced = <T>(
  name: string,
  fn: () => Promise<T>,
  carrier?: Record<string, unknown>,
) => {
  const parent = carrier
    ? propagation.extract(context.active(), carrier)
    : context.active();
  return context.with(parent, () =>
    trace.getTracer("sentinel").startActiveSpan(name, async (span) => {
      try {
        return await fn();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (error instanceof Error) span.recordException(error);
        throw error;
      } finally {
        span.end();
      }
    }),
  );
};
export const instrumentHttp = (app: FastifyInstance) => {
  const started = new WeakMap<
    object,
    {
      span: ReturnType<ReturnType<typeof trace.getTracer>["startSpan"]>;
      at: number;
    }
  >();
  app.addHook("onRequest", (req, reply, done) => {
    const parent = propagation.extract(context.active(), req.headers);
    const span = trace
      .getTracer("sentinel")
      .startSpan(
        "http.request",
        { attributes: { "http.request.method": req.method } },
        parent,
      );
    started.set(req, { span, at: performance.now() });
    reply.header("x-request-id", req.id);
    reply.header("x-trace-id", span.spanContext().traceId);
    context.with(trace.setSpan(parent, span), done);
  });
  app.addHook("onResponse", async (req, reply) => {
    const current = started.get(req);
    if (!current) return;
    current.span.setAttribute("http.response.status_code", reply.statusCode);
    current.span.setAttribute("http.route", req.routeOptions.url ?? "unknown");
    if (reply.statusCode >= 500)
      current.span.setStatus({ code: SpanStatusCode.ERROR });
    current.span.end();
    metrics
      .getMeter("sentinel")
      .createHistogram("http.server.duration", { unit: "ms" })
      .record(performance.now() - current.at, {
        route: req.routeOptions.url ?? "unknown",
        status: reply.statusCode,
      });
  });
};
