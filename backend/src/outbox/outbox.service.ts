import { Inject, Injectable, Optional } from '@nestjs/common';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import { MetricsService } from '../monitoring/metrics.service';
import { config } from '../config/env.config';
import { OutboxEvent, OutboxTransaction } from './outbox.types';
import { OutboxEventState, OutboxEventType, OutboxEvent as LegacyOutboxEvent } from './outbox.entity';
import { randomUUID } from 'crypto';

// ─── Redis key constants ───────────────────────────────────────────────────────
const PENDING_KEY = 'outbox:pending';
const PROCESSING_KEY = 'outbox:processing';
const EVENT_KEY_PREFIX = 'outbox:event:';

// ─── Lua scripts ──────────────────────────────────────────────────────────────

/**
 * Atomically claims up to `count` events whose score (= nextAttemptAt) ≤ `now`.
 *
 * KEYS[1] = pending sorted set
 * KEYS[2] = processing sorted set
 * ARGV[1] = now (ms)
 * ARGV[2] = lease expiry (ms) = now + leaseMs
 * ARGV[3] = count
 *
 * Returns the list of claimed event IDs.
 */
const CLAIM_DUE_SCRIPT = `
local members = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[3]))
for _, id in ipairs(members) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('ZADD', KEYS[2], ARGV[2], id)
end
return members
`;

/**
 * Moves all processing entries whose lease has expired back to pending.
 *
 * KEYS[1] = processing sorted set
 * KEYS[2] = pending sorted set
 * ARGV[1] = now (ms) — entries with score < now are expired
 * ARGV[2] = count cap
 *
 * Returns the list of reclaimed IDs.
 */
const RECLAIM_EXPIRED_SCRIPT = `
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('ZADD', KEYS[2], ARGV[1], id)
end
return expired
`;

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class OutboxService {
  private readonly logger = new SanitizedLogger(OutboxService.name);

  // ── In-memory fallback (used when Redis is null) ──
  private readonly memory = new Map<string, OutboxEvent>();
  private readonly pending = new Set<string>();
  private readonly processing = new Set<string>();

  // ── Legacy in-memory store (for createEvent/processEvent/replayEvent) ──
  private readonly legacyEvents = new Map<string, LegacyOutboxEvent>();
  private readonly legacyMaxAttempts = 10;

  constructor(
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // Core Redis-backed API
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Builds a new OutboxEvent but does NOT persist it yet — callers must follow
   * up with `append()` or `appendToTransaction()`.
   */
  create(type: string, aggregateType: string, aggregateId: string, payload: unknown): OutboxEvent {
    return {
      id: randomUUID(),
      dedupKey: `${type}:${aggregateType}:${aggregateId}:${Date.now()}`,
      type,
      aggregateType,
      aggregateId,
      payload,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: new Date().toISOString(),
    };
  }

  /** Persists an event created with `create()`. */
  async append(event: OutboxEvent): Promise<void> {
    if (this.redis) {
      const results = await this.redis
        .multi()
        .set(this.eventKey(event.id), JSON.stringify(event))
        .zadd(PENDING_KEY, event.nextAttemptAt, event.id)
        .exec();
      this.assertTransactionOk(results);
      return;
    }
    this.memory.set(event.id, event);
    this.pending.add(event.id);
  }

  /**
   * Writes the event body and enqueues it in the pending sorted set as part of
   * an existing Redis MULTI transaction.  Callers are responsible for calling
   * `.exec()` and checking the result.
   */
  appendToTransaction(transaction: OutboxTransaction, event: OutboxEvent): void {
    transaction
      .set(this.eventKey(event.id), JSON.stringify(event))
      .zadd(PENDING_KEY, event.nextAttemptAt, event.id);
  }

  /**
   * Claims up to `batchSize` events whose `nextAttemptAt` ≤ `now`, atomically
   * moving them from the pending set to the processing set with a lease expiry
   * of `now + leaseMs`.
   *
   * The `isWebhook` parameter is accepted for API compatibility with callers
   * that pass it, but the outbox uses a single key namespace for both kinds.
   */
  async claimDue(
    now: number,
    leaseMs: number,
    batchSize: number,
    _isWebhook = false,
  ): Promise<OutboxEvent[]> {
    if (this.redis) {
      const ids = (await this.redis.eval(
        CLAIM_DUE_SCRIPT,
        2,
        PENDING_KEY,
        PROCESSING_KEY,
        String(now),
        String(now + leaseMs),
        String(batchSize),
      )) as string[];

      return this.loadEvents(ids);
    }

    // In-memory fallback: claim up to batchSize IDs whose nextAttemptAt ≤ now
    const claimed: OutboxEvent[] = [];
    for (const id of this.pending) {
      if (claimed.length >= batchSize) break;
      const event = this.memory.get(id);
      if (event && event.nextAttemptAt <= now) {
        this.pending.delete(id);
        this.processing.add(id);
        claimed.push(event);
      }
    }
    return claimed;
  }

  /**
   * Returns expired processing leases to the pending set so they can be
   * re-claimed by the next sweep.
   */
  async reclaimExpired(
    now: number,
    batchSize: number,
    _isWebhook = false,
  ): Promise<string[]> {
    if (this.redis) {
      return (await this.redis.eval(
        RECLAIM_EXPIRED_SCRIPT,
        2,
        PROCESSING_KEY,
        PENDING_KEY,
        String(now),
        String(batchSize),
      )) as string[];
    }

    // In-memory fallback: all processing items are "expired" immediately
    const reclaimed: string[] = [];
    for (const id of this.processing) {
      if (reclaimed.length >= batchSize) break;
      this.processing.delete(id);
      this.pending.add(id);
      reclaimed.push(id);
    }
    return reclaimed;
  }

  /**
   * Marks an event as delivered, removes it from the processing set, and sets
   * a TTL on the event body for retention-period cleanup.
   */
  async markDelivered(event: OutboxEvent, _isWebhook = false): Promise<void> {
    const updated: OutboxEvent = {
      ...event,
      status: 'delivered',
      deliveredAt: new Date().toISOString(),
    };

    if (this.redis) {
      const ttl = config.OUTBOX_DELIVERED_TTL_SECONDS;
      const tx = this.redis
        .multi()
        .set(this.eventKey(event.id), JSON.stringify(updated))
        .zrem(PROCESSING_KEY, event.id)
        .zrem(PENDING_KEY, event.id);
      if (ttl > 0) tx.expire(this.eventKey(event.id), ttl);
      const results = await tx.exec();
      this.assertTransactionOk(results);
      return;
    }

    this.memory.set(event.id, updated);
    this.processing.delete(event.id);
    this.pending.delete(event.id);
  }

  /**
   * Increments the attempt counter and reschedules the event with exponential
   * backoff (capped at 30 s). Permanently fails the event once
   * `config.OUTBOX_MAX_ATTEMPTS` is reached.
   */
  async retry(event: OutboxEvent, error: unknown, _isWebhook = false): Promise<void> {
    const attempts = (event.attempts ?? 0) + 1;
    const errMsg = error instanceof Error ? error.message : String(error);
    const maxAttempts = config.OUTBOX_MAX_ATTEMPTS;
    const failed = attempts >= maxAttempts;

    const nextAttemptAt = failed
      ? event.nextAttemptAt
      : Date.now() + Math.min(1000 * 2 ** Math.min(attempts - 1, 5), 30_000);

    const updated: OutboxEvent = {
      ...event,
      attempts,
      lastError: errMsg,
      status: failed ? 'failed' : 'retrying',
      nextAttemptAt,
    };

    if (this.redis) {
      const tx = this.redis
        .multi()
        .set(this.eventKey(event.id), JSON.stringify(updated))
        .zrem(PROCESSING_KEY, event.id);
      if (!failed) tx.zadd(PENDING_KEY, nextAttemptAt, event.id);
      const results = await tx.exec();
      this.assertTransactionOk(results);

      if (failed) {
        this.logger.error(
          `Outbox event ${event.id} failed after ${attempts} attempts: ${errMsg}`,
        );
      }
      return;
    }

    this.memory.set(event.id, updated);
    this.processing.delete(event.id);
    if (failed) {
      this.logger.error(
        `Outbox event ${event.id} failed after ${attempts} attempts: ${errMsg}`,
      );
    } else {
      this.pending.add(event.id);
    }
  }

  /**
   * Fire-and-forget: queues a webhook event in the outbox.
   *
   * The first argument is reserved for a future Redis pipeline/transaction
   * context and is intentionally typed as `null` — callers always pass `null`
   * today, and the outbox handles its own persistence.
   */
  sendWebhook(
    _ctx: null,
    type: string,
    payload: unknown,
    dedupKey?: string,
  ): void {
    const event = this.create(type, 'webhook', dedupKey ?? type, payload);
    if (dedupKey) (event as OutboxEvent).dedupKey = dedupKey;
    this.append(event).catch(err =>
      this.logger.error(`sendWebhook: failed to append event ${event.id}: ${err}`),
    );
  }

  /** Finds a single event by ID. Returns undefined when not found. */
  async findById(id: string): Promise<OutboxEvent | undefined> {
    if (this.redis) {
      const raw = await this.redis.get(this.eventKey(id));
      if (!raw) return undefined;
      return JSON.parse(raw) as OutboxEvent;
    }
    return this.memory.get(id);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // replayAll — admin bulk-replay of failed/dead events
  // ══════════════════════════════════════════════════════════════════════════

  async replayAll(): Promise<{ succeeded: string[]; failed: Array<{ id: string; reason: string }> }> {
    const succeeded: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];

    // Redis path: scan for event bodies with status 'failed'
    if (this.redis) {
      const keys = await this.redis.keys(`${EVENT_KEY_PREFIX}*`);
      for (const key of keys) {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const event = JSON.parse(raw) as OutboxEvent;
        if (event.status !== 'failed') continue;
        try {
          const reset: OutboxEvent = {
            ...event,
            status: 'pending',
            attempts: 0,
            lastError: undefined,
            nextAttemptAt: Date.now(),
          };
          await this.redis
            .multi()
            .set(this.eventKey(event.id), JSON.stringify(reset))
            .zadd(PENDING_KEY, reset.nextAttemptAt, event.id)
            .exec();
          succeeded.push(event.id);
        } catch (err) {
          failed.push({
            id: event.id,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.logger.log(
        `replayAll: ${succeeded.length} succeeded, ${failed.length} failed`,
      );
      return { succeeded, failed };
    }

    // In-memory path
    for (const [id, event] of this.memory.entries()) {
      if (event.status !== 'failed') continue;
      try {
        const reset: OutboxEvent = {
          ...event,
          status: 'pending',
          attempts: 0,
          lastError: undefined,
          nextAttemptAt: Date.now(),
        };
        this.memory.set(id, reset);
        this.pending.add(id);
        succeeded.push(id);
      } catch (err) {
        failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { succeeded, failed };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Legacy in-memory admin API (used by outbox.controller.ts and unit tests)
  // ══════════════════════════════════════════════════════════════════════════

  async createEvent(eventType: OutboxEventType, payload: string): Promise<LegacyOutboxEvent> {
    const id = `obx-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const now = new Date();
    const event: LegacyOutboxEvent = {
      id,
      eventType,
      payload,
      state: OutboxEventState.PENDING,
      attempts: 0,
      maxAttempts: this.legacyMaxAttempts,
      createdAt: now,
      updatedAt: now,
    };
    this.legacyEvents.set(id, event);
    this.logger.log(`Created outbox event ${id} of type ${eventType}`);
    return event;
  }

  async getEvents(filter?: { state?: OutboxEventState }): Promise<LegacyOutboxEvent[]> {
    let all = [...this.legacyEvents.values()];
    if (filter?.state) {
      all = all.filter(e => e.state === filter.state);
    }
    return all;
  }

  async getEvent(id: string): Promise<LegacyOutboxEvent | undefined> {
    return this.legacyEvents.get(id);
  }

  getDeadLetterEvents(): LegacyOutboxEvent[] {
    return [...this.legacyEvents.values()].filter(
      e => e.state === OutboxEventState.DEAD_LETTER,
    );
  }

  async processEvent(id: string): Promise<{ success: boolean; error?: string }> {
    const event = this.legacyEvents.get(id);
    if (!event) throw new Error(`Outbox event ${id} not found`);
    if (event.state === OutboxEventState.DEAD_LETTER) {
      throw new Error(`Event ${id} is dead-lettered and must be replayed first`);
    }
    if (event.state === OutboxEventState.DELIVERED) {
      return { success: true };
    }

    event.state = OutboxEventState.PROCESSING;
    event.attempts += 1;
    event.updatedAt = new Date();

    try {
      await this.attemptDelivery(event);
      event.state = OutboxEventState.DELIVERED;
      event.processedAt = new Date();
      event.lastError = undefined;
      this.logger.log(`Event ${id} delivered on attempt ${event.attempts}`);
      return { success: true };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      event.lastError = errMsg;
      this.logger.warn(`Event ${id} delivery failed (attempt ${event.attempts}): ${errMsg}`);
      if (event.attempts >= event.maxAttempts) {
        event.state = OutboxEventState.DEAD_LETTER;
        event.deadLetteredAt = new Date();
        this.logger.error(
          `Event ${id} exceeded max attempts (${event.maxAttempts}). Moved to dead letter queue.`,
        );
      } else {
        event.state = OutboxEventState.FAILED;
      }
      return { success: false, error: errMsg };
    }
  }

  async replayEvent(id: string): Promise<{ success: boolean; error?: string }> {
    const event = this.legacyEvents.get(id);
    if (!event) throw new Error(`Outbox event ${id} not found`);
    if (event.state !== OutboxEventState.DEAD_LETTER) {
      throw new Error(`Event ${id} is not in dead-letter state (current: ${event.state})`);
    }
    event.state = OutboxEventState.PENDING;
    event.attempts = 0;
    event.lastError = undefined;
    event.deadLetteredAt = undefined;
    event.updatedAt = new Date();
    this.logger.log(`Replaying dead-lettered event ${id}`);
    return this.processEvent(id);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ══════════════════════════════════════════════════════════════════════════

  private eventKey(id: string): string {
    return `${EVENT_KEY_PREFIX}${id}`;
  }

  private assertTransactionOk(results: [Error | null, unknown][] | null): void {
    if (!results) throw new Error('Redis MULTI/EXEC transaction aborted (null result)');
    const failed = results.find(([err]) => err);
    if (failed) throw failed[0]!;
  }

  private async loadEvents(ids: string[]): Promise<OutboxEvent[]> {
    if (!this.redis || ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.get(this.eventKey(id));
    const results = await pipeline.exec();
    const events: OutboxEvent[] = [];
    for (let i = 0; i < ids.length; i++) {
      const [err, raw] = results![i]!;
      if (err || !raw) {
        // Body missing (e.g. crash between ZADD and SET) — leave in processing
        // so reclaimExpired() eventually returns it to pending.
        this.logger.warn(`Outbox event body missing for id ${ids[i]}: ${err ?? 'null'}`);
        continue;
      }
      events.push(JSON.parse(raw as string) as OutboxEvent);
    }
    return events;
  }

  private async attemptDelivery(event: LegacyOutboxEvent): Promise<void> {
    await new Promise(r => setTimeout(r, 10));
    if (event.payload.includes('"shouldFail":true')) {
      throw new Error('Simulated delivery failure');
    }
  }
}
