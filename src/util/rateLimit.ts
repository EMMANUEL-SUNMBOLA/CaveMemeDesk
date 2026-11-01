export class RateLimiter {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private minIntervalMs: number) {}

  async wait(): Promise<void> {
    const run = this.chain.then(async () => {
      const elapsed = Date.now() - this.last;
      if (elapsed < this.minIntervalMs) {
        await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
      }
      this.last = Date.now();
    });
    this.chain = run.catch(() => {});
    return run;
  }
}

export const limiters = {
  dexscreener: new RateLimiter(400),
  geckoterminal: new RateLimiter(6500),
  rugcheck: new RateLimiter(1200),
  goplus: new RateLimiter(1000),
  rpc: new RateLimiter(350),
};

export function configureLimiters(rl: {
  dexscreenerMinIntervalMs: number;
  geckoterminalMinIntervalMs: number;
  rugcheckMinIntervalMs: number;
  goplusMinIntervalMs: number;
  rpcMinIntervalMs: number;
}): void {
  limiters.dexscreener = new RateLimiter(rl.dexscreenerMinIntervalMs);
  limiters.geckoterminal = new RateLimiter(rl.geckoterminalMinIntervalMs);
  limiters.rugcheck = new RateLimiter(rl.rugcheckMinIntervalMs);
  limiters.goplus = new RateLimiter(rl.goplusMinIntervalMs);
  limiters.rpc = new RateLimiter(rl.rpcMinIntervalMs);
}
