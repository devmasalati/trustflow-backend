import { Test, TestingModule } from '@nestjs/testing';
import { OutboxService } from './outbox.service';
import { OutboxEventState, OutboxEventType } from './outbox.entity';

// OutboxService reads config.OUTBOX_MAX_ATTEMPTS via the Proxy, which calls
// getConfig() / validateEnv() the first time. Ensure the env is valid before tests run.
import { validateEnv, resetEnvConfig } from '../config/env.config';
validateEnv();

function makeService(): OutboxService {
  return new OutboxService(null, undefined);
}

// ══════════════════════════════════════════════════════════════════════════════
// Core Redis-backed API — exercised against the in-memory fallback
// ══════════════════════════════════════════════════════════════════════════════

describe('OutboxService — core API (in-memory fallback)', () => {
  let service: OutboxService;
  beforeEach(() => {
    service = makeService();
  });

  describe('create + append + findById', () => {
    it('creates an event with status pending and persists it', async () => {
      const event = service.create('gig.created', 'gig', 'gig-1', { id: 'gig-1' });
      expect(event.status).toBe('pending');
      expect(event.attempts).toBe(0);
      expect(event.id).toBeDefined();

      await service.append(event);
      const found = await service.findById(event.id);
      expect(found).toEqual(event);
    });
  });

  describe('claimDue', () => {
    it('claims a due event and returns it', async () => {
      const event = service.create('gig.created', 'gig', 'gig-1', {});
      await service.append(event);

      const claimed = await service.claimDue(Date.now(), 30_000, 10);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].id).toBe(event.id);
    });

    it('does not claim a future-scheduled event', async () => {
      const event = service.create('gig.created', 'gig', 'gig-1', {});
      event.nextAttemptAt = Date.now() + 60_000;
      await service.append(event);

      const claimed = await service.claimDue(Date.now(), 30_000, 10);
      expect(claimed).toHaveLength(0);
    });

    it('respects batchSize', async () => {
      for (let i = 0; i < 5; i++) {
        await service.append(service.create('t', 'x', `id-${i}`, {}));
      }
      const claimed = await service.claimDue(Date.now(), 30_000, 3);
      expect(claimed).toHaveLength(3);
    });
  });

  describe('reclaimExpired', () => {
    it('moves processing items back to pending so they can be re-claimed', async () => {
      const event = service.create('t', 'x', 'id-1', {});
      await service.append(event);
      await service.claimDue(Date.now(), 30_000, 1);

      const reclaimed = await service.reclaimExpired(Date.now() + 999, 10);
      expect(reclaimed).toHaveLength(1);

      const claimed2 = await service.claimDue(Date.now() + 999, 30_000, 10);
      expect(claimed2[0].id).toBe(event.id);
    });
  });

  describe('markDelivered', () => {
    it('marks a claimed event as delivered with a deliveredAt timestamp', async () => {
      const event = service.create('t', 'x', 'id-1', {});
      await service.append(event);
      const [claimed] = await service.claimDue(Date.now(), 30_000, 1);

      await service.markDelivered(claimed);

      const found = await service.findById(event.id);
      expect(found?.status).toBe('delivered');
      expect(found?.deliveredAt).toBeDefined();
    });
  });

  describe('retry', () => {
    it('reschedules a failed event with incremented attempts and retrying status', async () => {
      const event = service.create('t', 'x', 'id-1', {});
      await service.append(event);
      const [claimed] = await service.claimDue(Date.now(), 30_000, 1);

      await service.retry(claimed, new Error('oops'));

      const found = await service.findById(event.id);
      expect(found?.attempts).toBe(1);
      expect(found?.status).toBe('retrying');
      expect(found?.lastError).toBe('oops');
    });

    it('marks an event permanently failed at OUTBOX_MAX_ATTEMPTS', async () => {
      const previous = process.env.OUTBOX_MAX_ATTEMPTS;
      process.env.OUTBOX_MAX_ATTEMPTS = '1';
      resetEnvConfig();
      validateEnv();

      try {
        const svc = makeService();
        const event = svc.create('t', 'x', 'id-1', {});
        await svc.append(event);
        const [claimed] = await svc.claimDue(Date.now(), 30_000, 1);

        await svc.retry(claimed, new Error('poison'));

        const found = await svc.findById(event.id);
        expect(found?.status).toBe('failed');
        expect(found?.attempts).toBe(1);
      } finally {
        if (previous === undefined) delete process.env.OUTBOX_MAX_ATTEMPTS;
        else process.env.OUTBOX_MAX_ATTEMPTS = previous;
        resetEnvConfig();
        validateEnv();
      }
    });
  });

  describe('appendToTransaction', () => {
    it('calls set and zadd on the provided transaction object', () => {
      const tx = { set: jest.fn().mockReturnThis(), zadd: jest.fn().mockReturnThis() };
      const event = service.create('t', 'x', 'id-1', {});

      service.appendToTransaction(tx as any, event);

      expect(tx.set).toHaveBeenCalledWith(
        expect.stringContaining(event.id),
        expect.any(String),
      );
      expect(tx.zadd).toHaveBeenCalledWith('outbox:pending', event.nextAttemptAt, event.id);
    });
  });

  describe('replayAll', () => {
    it('resets failed events back to pending and returns succeeded ids', async () => {
      const previous = process.env.OUTBOX_MAX_ATTEMPTS;
      process.env.OUTBOX_MAX_ATTEMPTS = '1';
      resetEnvConfig();
      validateEnv();

      try {
        const svc = makeService();
        const event = svc.create('t', 'x', 'id-1', {});
        await svc.append(event);
        const [claimed] = await svc.claimDue(Date.now(), 30_000, 1);
        await svc.retry(claimed, new Error('poison'));

        const result = await svc.replayAll();
        expect(result.succeeded).toContain(event.id);
        expect(result.failed).toHaveLength(0);

        expect((await svc.findById(event.id))?.status).toBe('pending');
      } finally {
        if (previous === undefined) delete process.env.OUTBOX_MAX_ATTEMPTS;
        else process.env.OUTBOX_MAX_ATTEMPTS = previous;
        resetEnvConfig();
        validateEnv();
      }
    });
  });

  describe('sendWebhook', () => {
    it('does not throw synchronously', () => {
      expect(() =>
        service.sendWebhook(null, 'ipfs.pin.created', { cid: 'abc' }, 'key-1'),
      ).not.toThrow();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Legacy in-memory admin API (createEvent / processEvent / replayEvent)
// These methods are used by OutboxController and the original unit tests.
// ══════════════════════════════════════════════════════════════════════════════

describe('OutboxService — legacy admin API', () => {
  let service: OutboxService;
  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OutboxService],
    }).compile();
    service = module.get<OutboxService>(OutboxService);
  });

  describe('createEvent', () => {
    it('creates a PENDING event with the correct defaults', async () => {
      const event = await service.createEvent(
        OutboxEventType.DISPUTE_RAISED,
        '{"escrowId":"esc-123"}',
      );
      expect(event.id).toBeDefined();
      expect(event.state).toBe(OutboxEventState.PENDING);
      expect(event.attempts).toBe(0);
      expect(event.maxAttempts).toBe(10);
    });
  });

  describe('processEvent', () => {
    it('delivers a non-failing event', async () => {
      const event = await service.createEvent(
        OutboxEventType.ESCROW_CREATED,
        '{"shouldFail":false}',
      );
      const result = await service.processEvent(event.id);
      expect(result.success).toBe(true);
      expect((await service.getEvent(event.id))?.state).toBe(OutboxEventState.DELIVERED);
    });

    it('fails events with shouldFail flag', async () => {
      const event = await service.createEvent(
        OutboxEventType.DISPUTE_RAISED,
        '{"shouldFail":true}',
      );
      const result = await service.processEvent(event.id);
      expect(result.success).toBe(false);
    });
  });

  describe('dead letter queue', () => {
    it('moves events to DLQ after max attempts', async () => {
      const event = await service.createEvent(
        OutboxEventType.DISPUTE_RAISED,
        '{"shouldFail":true}',
      );
      for (let i = 0; i < 10; i++) {
        await service.processEvent(event.id);
      }

      const dlq = service.getDeadLetterEvents();
      expect(dlq.some(e => e.id === event.id)).toBe(true);

      const updated = await service.getEvent(event.id);
      expect(updated?.state).toBe(OutboxEventState.DEAD_LETTER);
      expect(updated?.attempts).toBe(10);
      expect(updated?.deadLetteredAt).toBeDefined();
    });

    it('does not block active queue when events are dead-lettered', async () => {
      const failEvent = await service.createEvent(
        OutboxEventType.DISPUTE_RAISED,
        '{"shouldFail":true}',
      );
      for (let i = 0; i < 10; i++) {
        await service.processEvent(failEvent.id);
      }

      const newEvent = await service.createEvent(
        OutboxEventType.ESCROW_CREATED,
        '{"test":true}',
      );
      const result = await service.processEvent(newEvent.id);
      expect(result.success).toBe(true);
    });
  });

  describe('replayEvent', () => {
    it('throws for non-dead-lettered events', async () => {
      const event = await service.createEvent(
        OutboxEventType.ESCROW_CREATED,
        '{"test":true}',
      );
      await expect(service.replayEvent(event.id)).rejects.toThrow('not in dead-letter state');
    });
  });

  describe('replayAll', () => {
    it('returns succeeded/failed properties', async () => {
      const e1 = await service.createEvent(
        OutboxEventType.DISPUTE_RAISED,
        '{"shouldFail":true}',
      );
      const e2 = await service.createEvent(
        OutboxEventType.EVIDENCE_SUBMITTED,
        '{"shouldFail":true}',
      );
      for (let i = 0; i < 10; i++) {
        await service.processEvent(e1.id);
        await service.processEvent(e2.id);
      }
      expect(service.getDeadLetterEvents().length).toBeGreaterThanOrEqual(2);

      const result = await service.replayAll();
      expect(result).toHaveProperty('succeeded');
      expect(result).toHaveProperty('failed');
    });
  });
});
