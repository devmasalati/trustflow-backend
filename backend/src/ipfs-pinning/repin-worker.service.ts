import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { IpfsPinningService } from './ipfs-pinning.service';
import { DEFAULT_REPIN_INTERVAL_MS, PinStatus } from './ipfs-pinning.types';
import { DistributedLockService } from '../common/redis/distributed-lock.service';
import { mapWithConcurrency } from '../common/concurrency';
import { config } from '../config/env.config';

const LOCK_KEY = 'lock:repin-sweep';

/**
 * Periodically sweeps every pin record that isn't fully healthy and re-reconciles it,
 * restoring replication once a previously-failed provider recovers or by promoting a
 * spare provider to replace one that permanently dropped the pin. This is what
 * guarantees CID durability over time rather than only at initial upload time.
 *
 * Interval is configurable via IPFS_REPIN_INTERVAL_MS (milliseconds); set to 0 or a
 * negative value to disable the background sweep entirely (e.g. in tests).
 *
 * Runs behind a Redis distributed lock (see `DistributedLockService`) so only one
 * instance's tick actually executes `runOnce()` when multiple instances are
 * deployed — same lease-per-tick scheme as `GigExpiryWorkerService`; see its doc
 * comment for the TTL/crash-recovery rationale.
 */
@Injectable()
export class RepinWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new SanitizedLogger(RepinWorkerService.name);
  private timer?: NodeJS.Timeout;
  private currentLockToken?: string;
  /** Guards against a slow sweep still running when the next tick fires. */
  private sweeping = false;

  constructor(
    private readonly pinningService: IpfsPinningService,
    private readonly lock: DistributedLockService,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.getIntervalMs();
    if (intervalMs <= 0) {
      this.logger.log('Re-pin worker disabled (IPFS_REPIN_INTERVAL_MS <= 0)');
      return;
    }

    this.timer = setInterval(() => {
      this.tick(intervalMs).catch(error => this.logger.error('Re-pin sweep failed', error));
    }, intervalMs);
    this.timer.unref?.();

    this.logger.log(`Re-pin worker started — sweeping every ${intervalMs}ms`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.currentLockToken) {
      await this.lock.release(LOCK_KEY, this.currentLockToken);
      this.currentLockToken = undefined;
    }
  }

  private async tick(intervalMs: number): Promise<void> {
    if (this.sweeping) {
      this.logger.warn('Previous re-pin sweep still in flight — skipping this tick');
      return;
    }
    const token = await this.lock.tryAcquire(LOCK_KEY, Math.ceil(intervalMs * 1.5));
    if (!token) {
      return; // another instance is holding the lock for this tick
    }
    this.currentLockToken = token;
    this.sweeping = true;
    try {
      await this.runOnce();
    } finally {
      this.sweeping = false;
      await this.lock.release(LOCK_KEY, token);
      this.currentLockToken = undefined;
    }
  }

  /** Runs a single sweep. Exposed so it can also be triggered manually (e.g. from tests or an admin endpoint). */
  async runOnce(): Promise<void> {
    const all = await this.pinningService.findAll();
    const targets = all.filter(
      record => record.status === PinStatus.DEGRADED || record.status === PinStatus.FAILED,
    );

    // Reconcile CIDs with bounded concurrency rather than serially — each
    // `reconcile()` makes per-provider network calls, so a sweep over many
    // degraded pins scaled linearly with pin count x provider latency (#237).
    // The per-CID try/catch is kept inside the worker so one bad CID is
    // isolated and logged, exactly as before.
    await mapWithConcurrency(targets, config.IPFS_REPIN_SWEEP_CONCURRENCY, async record => {
      try {
        const result = await this.pinningService.reconcile(record.cid);
        if (
          result.status === PinStatus.DEGRADED ||
          result.status === PinStatus.FAILED
        ) {
          this.logger.warn(
            `Re-pin sweep: ${record.cid} remains ${result.status} after reconcile — ` +
              `original content is not retained; re-upload required to restore full replication.`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Re-pin sweep: could not reconcile ${record.cid}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  }

  private getIntervalMs(): number {
    return config.IPFS_REPIN_INTERVAL_MS ?? DEFAULT_REPIN_INTERVAL_MS;
  }
}
