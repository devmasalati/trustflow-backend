import { Injectable, NotFoundException } from '@nestjs/common';
import * as http from 'http';
import * as https from 'https';
import { v4 as uuidv4 } from 'uuid';
import { SanitizedLogger } from '../common/logging/sanitized-logger';
import { computeWebhookSignature, validateWebhookUrl } from './webhook.service';
import {
  CreateWebhookSubscriptionSchema,
  UpdateWebhookSubscriptionSchema,
} from './webhook-subscription.dto';
import type {
  CreateWebhookSubscriptionDto,
  UpdateWebhookSubscriptionDto,
} from './webhook-subscription.dto';

/** Internal subscription record — the raw secret is retained for request signing. */
export interface WebhookSubscription {
  id: string;
  dappId: string;
  url: string;
  topics: string[];
  /** HMAC-SHA256 secret used to sign outbound payloads. Never exposed in API responses. */
  secret?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Result of a ping probe against a subscription endpoint. */
export interface WebhookSubscriptionPingResult {
  /** True when the endpoint responded with a 2xx status. */
  reachable: boolean;
  /** Round-trip time in milliseconds. */
  responseTimeMs: number;
  /** HTTP status code returned by the endpoint, when a response was received. */
  statusCode?: number;
}

/** Timeout for ping probes. */
const PING_TIMEOUT_MS = 5_000;

/**
 * In-memory store for webhook subscriptions.
 *
 * Subscriptions are keyed by their UUID. The store is process-local: it is
 * intended for development, testing, and single-instance deployments. A
 * persistent implementation should back this with the database while keeping
 * the same method signatures.
 */
@Injectable()
export class WebhookSubscriptionService {
  private readonly logger = new SanitizedLogger(WebhookSubscriptionService.name);
  private readonly subscriptions = new Map<string, WebhookSubscription>();

  /**
   * Create a subscription. The URL must be https and must not resolve to a
   * private address (validated via {@link validateWebhookUrl}).
   */
  async create(dto: CreateWebhookSubscriptionDto): Promise<WebhookSubscription> {
    const data = CreateWebhookSubscriptionSchema.parse(dto);
    await validateWebhookUrl(data.url);

    const subscription: WebhookSubscription = {
      id: uuidv4(),
      dappId: data.dappId,
      url: data.url,
      topics: data.topics,
      ...(data.secret !== undefined ? { secret: data.secret } : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.subscriptions.set(subscription.id, subscription);
    this.logger.log(`Created webhook subscription ${subscription.id} for dApp ${data.dappId}`);
    return subscription;
  }

  /** List every subscription belonging to `dappId`, newest first. */
  listByDapp(dappId: string): WebhookSubscription[] {
    return Array.from(this.subscriptions.values())
      .filter(s => s.dappId === dappId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Fetch a single subscription by ID, or undefined when it does not exist. */
  getById(id: string): WebhookSubscription | undefined {
    return this.subscriptions.get(id);
  }

  /** Partially update a subscription. At least one field must be provided. */
  async update(
    id: string,
    dto: UpdateWebhookSubscriptionDto,
  ): Promise<WebhookSubscription> {
    const data = UpdateWebhookSubscriptionSchema.parse(dto);

    const existing = this.subscriptions.get(id);
    if (!existing) {
      throw new NotFoundException(`Webhook subscription ${id} not found`);
    }
    if (data.url !== undefined) await validateWebhookUrl(data.url);

    const updated: WebhookSubscription = {
      ...existing,
      ...(data.dappId !== undefined ? { dappId: data.dappId } : {}),
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.topics !== undefined ? { topics: data.topics } : {}),
      ...(data.secret !== undefined ? { secret: data.secret } : {}),
      updatedAt: new Date(),
    };
    this.subscriptions.set(id, updated);
    this.logger.log(`Updated webhook subscription ${id}`);
    return updated;
  }

  /** Delete a subscription. Returns true when a record was removed. */
  remove(id: string): boolean {
    const removed = this.subscriptions.delete(id);
    if (removed) this.logger.log(`Deleted webhook subscription ${id}`);
    return removed;
  }

  /**
   * Probe the subscription endpoint with a signed test POST and report
   * reachability. Resolves (never throws for network failures) with
   * `reachable: false` when the endpoint errors or times out.
   */
  async ping(id: string): Promise<WebhookSubscriptionPingResult> {
    const subscription = this.subscriptions.get(id);
    if (!subscription) {
      throw new NotFoundException(`Webhook subscription ${id} not found`);
    }

    const payload = JSON.stringify({
      type: 'ping',
      timestamp: new Date().toISOString(),
      subscriptionId: id,
    });

    const startedAt = Date.now();
    try {
      const statusCode = await this.post(subscription.url, payload, subscription.secret);
      return {
        reachable: statusCode >= 200 && statusCode < 300,
        responseTimeMs: Date.now() - startedAt,
        statusCode,
      };
    } catch (err) {
      this.logger.warn(
        `Ping to subscription ${id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { reachable: false, responseTimeMs: Date.now() - startedAt };
    }
  }

  /**
   * Fire a single POST at the subscription URL and resolve with the response
   * status code. Rejects on transport error or timeout.
   */
  private post(url: string, body: string, secret?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const transport = url.startsWith('https') ? https : http;
      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      };
      if (secret) {
        headers['X-TrustFlow-Signature'] = computeWebhookSignature(body, secret);
      }

      const req = transport.request(
        url,
        { method: 'POST', headers },
        res => {
          res.resume(); // drain the body so the socket can close cleanly
          resolve(res.statusCode ?? 0);
        },
      );
      req.setTimeout(PING_TIMEOUT_MS, () => {
        req.destroy(new Error(`Ping timed out after ${PING_TIMEOUT_MS}ms`));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
