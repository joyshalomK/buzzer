// Estimates the offset between this device's clock and the database clock
// from ordinary RPC round trips (NTP-style): the server read its clock
// somewhere between send (t0) and receive (t1), so the best guess is the
// midpoint, and the sample with the shortest round trip is the most precise.
// Used only to show the countdown / enable the button at the right moment;
// acceptance and timing are always decided by the server.

interface Sample {
  offset: number;
  rtt: number;
}

const MAX_SAMPLES = 10;

export class ServerClock {
  private samples: Sample[] = [];

  sample(t0: number, t1: number, serverMs: number) {
    if (!Number.isFinite(serverMs) || t1 < t0) return;
    this.samples.push({ offset: serverMs - (t0 + t1) / 2, rtt: t1 - t0 });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
  }

  /** server time minus local time, in ms (0 until the first sample) */
  get offset() {
    if (this.samples.length === 0) return 0;
    return this.samples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset;
  }

  /** uncertainty of the current estimate (half the best round trip) */
  get accuracy() {
    if (this.samples.length === 0) return Infinity;
    return Math.min(...this.samples.map((s) => s.rtt)) / 2;
  }

  /** current server time estimate */
  now(local = Date.now()) {
    return local + this.offset;
  }
}

export const serverClock = new ServerClock();

/** Runs an RPC that returns `server_now_ms` and feeds the clock estimate. */
export async function timed<T extends { server_now_ms: number }>(fn: () => Promise<T>, clock = serverClock): Promise<T> {
  const t0 = Date.now();
  const r = await fn();
  clock.sample(t0, Date.now(), r.server_now_ms);
  return r;
}
