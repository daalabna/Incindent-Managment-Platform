import { expect, it, vi } from "vitest";
import { startOperations } from "../../server/operations/worker";
import { startPeriodicTask } from "../../server/runtime/periodic-task";

it("runs fast tasks independently while a slow task waits; stop drains all in-flight work", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = vi.fn(() => gate);
  const fast = vi.fn(async () => undefined);
  const reports = vi.fn();
  const fail = vi.fn(async () => {
    throw new Error("boom");
  });
  const operations = startOperations(reports, [slow, fast, fail], 20);
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fast).toHaveBeenCalledTimes(5);
    expect(reports).toHaveBeenCalledTimes(5);
    let stopped = false;
    const stopping = operations.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).toBe(false);
    expect(fast).toHaveBeenCalledTimes(5);
    release();
    await stopping;
    expect(stopped).toBe(true);
  } finally {
    release();
    await operations.stop();
    vi.useRealTimers();
  }
});

it("handles synchronous failures, readiness and recovery without overlapping invocations", async () => {
  vi.useFakeTimers();
  let ready = false;
  const error = new Error("sync failure");
  const tick = vi
    .fn<() => Promise<void>>()
    .mockImplementationOnce(() => {
      throw error;
    })
    .mockResolvedValue(undefined);
  const report = vi.fn();
  const task = startPeriodicTask(tick, 10, report, () => ready);
  try {
    await vi.advanceTimersByTimeAsync(20);
    expect(tick).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(report).toHaveBeenCalledWith(error);
    await vi.advanceTimersByTimeAsync(10);
    expect(tick).toHaveBeenCalledTimes(2);
    await task.stop();
    await vi.advanceTimersByTimeAsync(20);
    expect(tick).toHaveBeenCalledTimes(2);
  } finally {
    await task.stop();
    vi.useRealTimers();
  }
});
