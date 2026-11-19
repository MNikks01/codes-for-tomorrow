import type { Logger } from 'pino';

export interface DependencyCheck {
  name: string;
  check(): Promise<void>;
}

export type DependencyStatus = 'up' | 'down';

export interface ReadinessReport {
  ready: boolean;
  shuttingDown: boolean;
  dependencies: Record<string, DependencyStatus>;
}

export interface ReadinessOptions {
  /** Results are cached so probes cannot hammer the databases. */
  cacheTtlMs: number;
  timeoutMs: number;
}

export class ReadinessService {
  private cached: { at: number; report: ReadinessReport } | undefined;
  private shuttingDown = false;

  constructor(
    private readonly checks: readonly DependencyCheck[],
    private readonly options: ReadinessOptions,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Makes the instance report not-ready so load balancers drain it before shutdown. */
  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  async report(): Promise<ReadinessReport> {
    if (this.shuttingDown) return { ready: false, shuttingDown: true, dependencies: {} };
    if (this.cached && this.now() - this.cached.at < this.options.cacheTtlMs) {
      return this.cached.report;
    }
    const results = await Promise.all(
      this.checks.map(async (dependency): Promise<[string, DependencyStatus]> => {
        try {
          await withTimeout(dependency.check(), this.options.timeoutMs);
          return [dependency.name, 'up'];
        } catch (err) {
          this.logger.warn({ err, dependency: dependency.name }, 'Readiness check failed');
          return [dependency.name, 'down'];
        }
      }),
    );
    const report: ReadinessReport = {
      ready: results.every(([, status]) => status === 'up'),
      shuttingDown: false,
      dependencies: Object.fromEntries(results),
    };
    this.cached = { at: this.now(), report };
    return report;
  }
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
