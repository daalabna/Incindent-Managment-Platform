/** One in-flight invocation per task. Independent instances never block each other. */
export const startPeriodicTask = (
  tick: () => Promise<unknown>,
  intervalMs: number,
  onError: (error: unknown) => void,
  ready: () => boolean = () => true,
) => {
  let work: Promise<void> | undefined;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || work) return;
    work = Promise.resolve()
      .then(async () => {
        if (ready()) await tick();
      })
      .catch(onError)
      .finally(() => {
        work = undefined;
      });
  }, intervalMs);
  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await work;
    },
  };
};
