/** OPSH-02/03: HTTP reads a snapshot only. Sampling never ingests incidents. */
/** @param {{sample: () => Promise<{worker:boolean,queue:boolean,commands:boolean}>, now?:()=>number, intervalMs?:number, maxAgeMs?:number, onFailure?:()=>void, setTimer?:typeof setInterval, clearTimer?:typeof clearInterval}} options */
export function createOperationalHealth({
  sample,
  now = Date.now,
  intervalMs = 60_000,
  maxAgeMs = 120_000,
  onFailure = () => {},
  setTimer = globalThis.setInterval,
  clearTimer = globalThis.clearInterval,
}) {
  /** @type {{checkedAt: number, checks: {worker: boolean, queue: boolean, commands: boolean}}|undefined} */
  let snapshot;
  /** @type {Promise<void>|undefined} */
  let inFlight;
  /** @type {ReturnType<typeof setInterval>|undefined} */
  let timer;
  let stopped = false;
  const refresh = () => {
    if (inFlight || stopped) return inFlight;
    inFlight = (async () => {
      try {
        const startedAt = now();
        const checks = await sample();
        snapshot = { checkedAt: startedAt, checks };
      } catch {
        snapshot = undefined;
        onFailure();
      }
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
  return {
    refresh,
    start() {
      if (timer || stopped) return;
      void refresh();
      timer = setTimer(() => {
        void refresh();
      }, intervalMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      await inFlight;
    },
    read() {
      if (
        !snapshot ||
        now() < snapshot.checkedAt ||
        now() - snapshot.checkedAt > maxAgeMs
      )
        return { statusCode: 503, body: { status: 'unavailable' } };
      const checks = Object.fromEntries(
        ['worker', 'queue', 'commands'].map((key) => [
          key,
          snapshot?.checks[/** @type {'worker'|'queue'|'commands'} */ (key)] ===
          true
            ? 'ok'
            : 'degraded',
        ]),
      );
      const healthy = Object.values(checks).every((value) => value === 'ok');
      return {
        statusCode: healthy ? 200 : 503,
        body: {
          status: healthy ? 'ok' : 'degraded',
          checkedAt: new Date(snapshot.checkedAt).toISOString(),
          checks,
        },
      };
    },
  };
}
