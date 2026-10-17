/**
 * E2E-style tests for the webhook subscription management API.
 *
 * Spins up the real controller + service through a Nest testing module and
 * drives it with supertest over HTTP. URL validation (validateWebhookUrl) is
 * mocked so loopback test endpoints are accepted, while
 * computeWebhookSignature keeps its real HMAC implementation so ping
 * signatures can be verified.
 */

import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { createHmac } from 'crypto';
import request from 'supertest';
import { JwtAuthGuard } from '../auth/auth.guard';
import { WebhookSubscriptionController } from './webhook-subscription.controller';
import { WebhookSubscriptionService } from './webhook-subscription.service';

// The local hook test server uses a throwaway self-signed certificate (see
// beforeAll), so TLS verification is relaxed for this test process only.
// Production code paths are unaffected.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

jest.mock('./webhook.service', () => {
  const crypto = require('crypto');
  return {
    validateWebhookUrl: jest.fn().mockResolvedValue(undefined),
    computeWebhookSignature: (body: string, secret: string) =>
      crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex'),
  };
});

const DAPP_ID = 'dapp-abc-123';
const OTHER_DAPP_ID = 'dapp-other-456';

interface CapturedRequest {
  body: string;
  signature?: string;
}

describe('WebhookSubscriptionController (e2e)', () => {
  let app: INestApplication;
  let hookServer: https.Server;
  let hookUrl: string;
  let captured: CapturedRequest | null;

  /** JwtAuthGuard replacement — stamps the request with a fixed JWT payload. */
  const guard = {
    canActivate: (ctx: ExecutionContext) => {
      ctx.switchToHttp().getRequest().user = { sub: DAPP_ID, address: DAPP_ID };
      return true;
    },
  };

  beforeAll(async () => {
    captured = null;

    // Subscriptions must be https, so the local hook server needs a certificate.
    // A throwaway self-signed pair is generated with openssl for the test run.
    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trustflow-hooks-'));
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} ` +
        `-days 1 -nodes -subj "/CN=127.0.0.1" 2>/dev/null`,
    );
    const key = fs.readFileSync(keyPath, 'utf8');
    const cert = fs.readFileSync(certPath, 'utf8');

    // Local endpoint that captures whatever the service POSTs at it.
    hookServer = https.createServer({ key, cert }, (req, res) => {
      let raw = '';
      req.on('data', chunk => (raw += chunk));
      req.on('end', () => {
        captured = {
          body: raw,
          signature: (req.headers['x-trustflow-signature'] as string) ?? undefined,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>(resolve => hookServer.listen(0, '127.0.0.1', resolve));
    const address = hookServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start local hook test server');
    }
    hookUrl = `https://127.0.0.1:${address.port}/hooks/trustflow`;
  });

  afterAll(async () => {
    await new Promise(resolve => hookServer.close(resolve));
  });

  beforeEach(async () => {
    captured = null;
    const module = await Test.createTestingModule({
      controllers: [WebhookSubscriptionController],
      providers: [WebhookSubscriptionService],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(guard)
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  /** Create a subscription via the API and return the response body. */
  async function createSubscription(payload: Record<string, unknown>): Promise<any> {
    const response = await request(app.getHttpServer())
      .post('/webhooks/subscriptions')
      .send(payload)
      .expect(201);
    return response.body;
  }

  // ── POST /webhooks/subscriptions ─────────────────────────────────────────

  describe('POST /webhooks/subscriptions', () => {
    it('creates a subscription and returns 201', async () => {
      const body = await createSubscription({
        dappId: DAPP_ID,
        url: 'https://dapp.example.com/hooks/trustflow',
        topics: ['escrow.created', 'dispute.raised'],
      });

      expect(body.id).toBeDefined();
      expect(body.dappId).toBe(DAPP_ID);
      expect(body.url).toBe('https://dapp.example.com/hooks/trustflow');
      expect(body.topics).toEqual(['escrow.created', 'dispute.raised']);
      expect(typeof body.createdAt).toBe('string');
      expect(typeof body.updatedAt).toBe('string');
    });

    it('masks the secret in the response', async () => {
      const body = await createSubscription({
        dappId: DAPP_ID,
        url: 'https://dapp.example.com/hook',
        topics: ['*'],
        secret: 'my-super-secret-value',
      });

      expect(body.secret).toBe('my-s****');
      expect(body.secret).not.toContain('super-secret');
    });

    it('returns 400 when dappId is missing', async () => {
      const response = await request(app.getHttpServer())
        .post('/webhooks/subscriptions')
        .send({ url: 'https://dapp.example.com/hook', topics: ['*'] })
        .expect(400);

      expect(response.body.message).toBeDefined();
    });

    it('returns 400 for a non-https URL', async () => {
      const response = await request(app.getHttpServer())
        .post('/webhooks/subscriptions')
        .send({ dappId: DAPP_ID, url: 'http://dapp.example.com/hook', topics: ['*'] })
        .expect(400);

      expect(response.body.message).toBeDefined();
    });

    it('returns 400 for an invalid URL', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/subscriptions')
        .send({ dappId: DAPP_ID, url: 'not-a-url', topics: ['*'] })
        .expect(400);
    });

    it('returns 400 when topics is empty', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/subscriptions')
        .send({ dappId: DAPP_ID, url: 'https://dapp.example.com/hook', topics: [] })
        .expect(400);
    });

    it('returns 400 when the secret is shorter than 16 characters', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/subscriptions')
        .send({
          dappId: DAPP_ID,
          url: 'https://dapp.example.com/hook',
          topics: ['*'],
          secret: 'short',
        })
        .expect(400);
    });
  });

  // ── GET /webhooks/subscriptions ──────────────────────────────────────────

  describe('GET /webhooks/subscriptions', () => {
    it('lists subscriptions for the authenticated dApp (JWT sub)', async () => {
      await createSubscription({
        dappId: DAPP_ID,
        url: 'https://a.example.com/hook',
        topics: ['*'],
      });
      await createSubscription({
        dappId: DAPP_ID,
        url: 'https://b.example.com/hook',
        topics: ['escrow.created'],
      });
      await createSubscription({
        dappId: OTHER_DAPP_ID,
        url: 'https://c.example.com/hook',
        topics: ['*'],
      });

      const response = await request(app.getHttpServer())
        .get('/webhooks/subscriptions')
        .expect(200);

      expect(response.body).toHaveLength(2);
      expect(response.body.every((s: any) => s.dappId === DAPP_ID)).toBe(true);
    });

    it('returns 403 when a caller-supplied dappId does not match the JWT sub', async () => {
      await createSubscription({ dappId: DAPP_ID, url: 'https://a.example.com/hook', topics: ['*'] });

      await request(app.getHttpServer())
        .get(`/webhooks/subscriptions?dappId=${OTHER_DAPP_ID}`)
        .expect(403);
    });

    it('returns an empty list when the dApp has no subscriptions', async () => {
      const response = await request(app.getHttpServer())
        .get('/webhooks/subscriptions?dappId=unknown-dapp')
        .expect(200);

      expect(response.body).toEqual([]);
    });
  });

  // ── GET /webhooks/subscriptions/:id ──────────────────────────────────────

  describe('GET /webhooks/subscriptions/:id', () => {
    it('returns a single subscription', async () => {
      const created = await createSubscription({
        dappId: DAPP_ID,
        url: 'https://dapp.example.com/hook',
        topics: ['escrow.created'],
        secret: 'my-super-secret-value',
      });

      const response = await request(app.getHttpServer())
        .get(`/webhooks/subscriptions/${created.id}`)
        .expect(200);

      expect(response.body.id).toBe(created.id);
      expect(response.body.dappId).toBe(DAPP_ID);
      expect(response.body.url).toBe('https://dapp.example.com/hook');
      expect(response.body.topics).toEqual(['escrow.created']);
      expect(response.body.secret).toBe('my-s****');
    });

    it('returns 404 for an unknown subscription', async () => {
      await request(app.getHttpServer())
        .get('/webhooks/subscriptions/00000000-0000-0000-0000-000000000000')
        .expect(404);
    });
  });

  // ── PATCH /webhooks/subscriptions/:id ────────────────────────────────────

  describe('PATCH /webhooks/subscriptions/:id', () => {
    it('updates subscription fields', async () => {
      const created = await createSubscription({
        dappId: DAPP_ID,
        url: 'https://dapp.example.com/hook',
        topics: ['*'],
      });

      const response = await request(app.getHttpServer())
        .patch(`/webhooks/subscriptions/${created.id}`)
        .send({
          topics: ['escrow.created', 'escrow.executed'],
          url: 'https://new.example.com/hook',
        })
        .expect(200);

      expect(response.body.topics).toEqual(['escrow.created', 'escrow.executed']);
      expect(response.body.url).toBe('https://new.example.com/hook');

      // The change is persisted, not just echoed back.
      const fetched = await request(app.getHttpServer())
        .get(`/webhooks/subscriptions/${created.id}`)
        .expect(200);
      expect(fetched.body.topics).toEqual(['escrow.created', 'escrow.executed']);
      expect(fetched.body.url).toBe('https://new.example.com/hook');
    });

    it('updates the secret and returns the new masked value', async () => {
      const created = await createSubscription({
        dappId: DAPP_ID,
        url: 'https://dapp.example.com/hook',
        topics: ['*'],
      });

      const response = await request(app.getHttpServer())
        .patch(`/webhooks/subscriptions/${created.id}`)
        .send({ secret: 'another-secret-value-32' })
        .expect(200);

      expect(response.body.secret).toBe('anot****');
    });

    it('returns 404 for an unknown subscription', async () => {
      await request(app.getHttpServer())
        .patch('/webhooks/subscriptions/00000000-0000-0000-0000-000000000000')
        .send({ topics: ['*'] })
        .expect(404);
    });

    it('returns 400 when the payload is empty', async () => {
      const created = await createSubscription({
        dappId: DAPP_ID,
        url: 'https://dapp.example.com/hook',
        topics: ['*'],
      });

      await request(app.getHttpServer())
        .patch(`/webhooks/subscriptions/${created.id}`)
        .send({})
        .expect(400);
    });
  });

  // ── DELETE /webhooks/subscriptions/:id ───────────────────────────────────

  describe('DELETE /webhooks/subscriptions/:id', () => {
    it('removes the subscription', async () => {
      const created = await createSubscription({
        dappId: DAPP_ID,
        url: 'https://dapp.example.com/hook',
        topics: ['*'],
      });

      const response = await request(app.getHttpServer())
        .delete(`/webhooks/subscriptions/${created.id}`)
        .expect(200);
      expect(response.body).toEqual({ deleted: true, id: created.id });

      await request(app.getHttpServer())
        .get(`/webhooks/subscriptions/${created.id}`)
        .expect(404);
    });

    it('returns 404 for an unknown subscription', async () => {
      await request(app.getHttpServer())
        .delete('/webhooks/subscriptions/00000000-0000-0000-0000-000000000000')
        .expect(404);
    });
  });

  // ── POST /webhooks/subscriptions/:id/ping ────────────────────────────────

  describe('POST /webhooks/subscriptions/:id/ping', () => {
    it('returns reachability status for a live endpoint', async () => {
      const created = await createSubscription({
        dappId: DAPP_ID,
        url: hookUrl,
        topics: ['*'],
      });

      const response = await request(app.getHttpServer())
        .post(`/webhooks/subscriptions/${created.id}/ping`)
        .expect(200);

      expect(response.body.reachable).toBe(true);
      expect(response.body.statusCode).toBe(200);
      expect(typeof response.body.responseTimeMs).toBe('number');
      expect(response.body.responseTimeMs).toBeGreaterThanOrEqual(0);

      // The local hook received the ping payload with the expected shape.
      expect(captured).not.toBeNull();
      const payload = JSON.parse(captured!.body);
      expect(payload.type).toBe('ping');
      expect(typeof payload.timestamp).toBe('string');
      expect(new Date(payload.timestamp).toString()).not.toBe('Invalid Date');
      expect(payload.subscriptionId).toBe(created.id);
    });

    it('signs the ping payload when a secret is configured', async () => {
      const secret = 'my-super-secret-value';
      const created = await createSubscription({
        dappId: DAPP_ID,
        url: hookUrl,
        topics: ['*'],
        secret,
      });

      await request(app.getHttpServer())
        .post(`/webhooks/subscriptions/${created.id}/ping`)
        .expect(200);

      expect(captured?.signature).toBe(
        createHmac('sha256', secret).update(captured!.body, 'utf8').digest('hex'),
      );
    });

    it('omits the signature header when no secret is configured', async () => {
      const created = await createSubscription({
        dappId: DAPP_ID,
        url: hookUrl,
        topics: ['*'],
      });

      await request(app.getHttpServer())
        .post(`/webhooks/subscriptions/${created.id}/ping`)
        .expect(200);

      expect(captured).not.toBeNull();
      expect(captured?.signature).toBeUndefined();
    });

    it('returns reachable=false when the endpoint is unreachable', async () => {
      const created = await createSubscription({
        dappId: DAPP_ID,
        url: 'https://127.0.0.1:1/hooks/trustflow', // nothing is listening here
        topics: ['*'],
      });

      const response = await request(app.getHttpServer())
        .post(`/webhooks/subscriptions/${created.id}/ping`)
        .expect(200);

      expect(response.body.reachable).toBe(false);
      expect(response.body.statusCode).toBeUndefined();
    });

    it('returns 404 for an unknown subscription', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/subscriptions/00000000-0000-0000-0000-000000000000/ping')
        .expect(404);
    });

    it('returns reachable=false when the endpoint presents an invalid TLS certificate', async () => {
      // Temporarily re-enable TLS verification for this test only by removing
      // the process-wide bypass that the rest of the suite relies on.
      // This proves post() no longer passes rejectUnauthorized: false.
      const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

      try {
        // hookUrl uses a self-signed cert — without the bypass it should be rejected.
        const service = app.get(WebhookSubscriptionService);
        const sub = await service.create({
          dappId: DAPP_ID,
          url: hookUrl,
          topics: ['*'],
        });

        const result = await service.ping(sub.id);
        expect(result.reachable).toBe(false);
        expect(result.statusCode).toBeUndefined();
      } finally {
        // Restore so subsequent tests keep working with the self-signed cert.
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
      }
    });
  });

  // ── Ownership enforcement (cross-dApp access) ─────────────────────────────

  describe('cross-dApp ownership enforcement', () => {
    /**
     * Creates a subscription directly via the service under OTHER_DAPP_ID,
     * bypassing the controller so we can set up a subscription the authenticated
     * caller (DAPP_ID) does not own.
     */
    let otherSubId: string;
    let service: WebhookSubscriptionService;

    beforeEach(async () => {
      service = app.get(WebhookSubscriptionService);
      const sub = await service.create({
        dappId: OTHER_DAPP_ID,
        url: 'https://other.example.com/hook',
        topics: ['*'],
        secret: 'other-dapp-secret-value',
      });
      otherSubId = sub.id;
    });

    it('create() ignores a caller-supplied dappId and uses the JWT sub instead', async () => {
      const response = await request(app.getHttpServer())
        .post('/webhooks/subscriptions')
        .send({ dappId: OTHER_DAPP_ID, url: 'https://dapp.example.com/hook', topics: ['*'] })
        .expect(201);

      // The stored dappId must be the JWT sub, not the one in the body.
      expect(response.body.dappId).toBe(DAPP_ID);
    });

    it('findAll() returns 403 when dappId query param belongs to another dApp', async () => {
      await request(app.getHttpServer())
        .get(`/webhooks/subscriptions?dappId=${OTHER_DAPP_ID}`)
        .expect(403);
    });

    it('findAll() with own dappId query param works normally', async () => {
      await createSubscription({ dappId: DAPP_ID, url: 'https://a.example.com/hook', topics: ['*'] });
      const response = await request(app.getHttpServer())
        .get(`/webhooks/subscriptions?dappId=${DAPP_ID}`)
        .expect(200);
      expect(response.body.every((s: any) => s.dappId === DAPP_ID)).toBe(true);
    });

    it('findOne() returns 403 for a subscription owned by another dApp', async () => {
      await request(app.getHttpServer())
        .get(`/webhooks/subscriptions/${otherSubId}`)
        .expect(403);
    });

    it('update() returns 403 for a subscription owned by another dApp', async () => {
      await request(app.getHttpServer())
        .patch(`/webhooks/subscriptions/${otherSubId}`)
        .send({ topics: ['escrow.created'] })
        .expect(403);
    });

    it('update() returns 403 when trying to reassign dappId to a different value', async () => {
      const own = await createSubscription({
        dappId: DAPP_ID,
        url: 'https://dapp.example.com/hook',
        topics: ['*'],
      });
      await request(app.getHttpServer())
        .patch(`/webhooks/subscriptions/${own.id}`)
        .send({ dappId: OTHER_DAPP_ID })
        .expect(403);
    });

    it('remove() returns 403 for a subscription owned by another dApp', async () => {
      await request(app.getHttpServer())
        .delete(`/webhooks/subscriptions/${otherSubId}`)
        .expect(403);

      // Subscription must still exist after the failed attempt.
      expect(service.getById(otherSubId)).toBeDefined();
    });

    it('ping() returns 403 for a subscription owned by another dApp', async () => {
      await request(app.getHttpServer())
        .post(`/webhooks/subscriptions/${otherSubId}/ping`)
        .expect(403);
    });
  });
});
