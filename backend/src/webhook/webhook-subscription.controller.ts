import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { ZodError } from 'zod';
import { JwtAuthGuard } from '../auth/auth.guard';
import {
  WebhookSubscriptionPingResult,
  WebhookSubscriptionService,
} from './webhook-subscription.service';
import type { WebhookSubscription } from './webhook-subscription.service';
import {
  CreateWebhookSubscriptionSchema,
  UpdateWebhookSubscriptionSchema,
  maskSecret,
  WebhookSubscriptionResponseDto,
} from './webhook-subscription.dto';

/**
 * Webhook subscription management for authenticated dApps.
 *
 * All routes require a valid JWT (see {@link JwtAuthGuard}). The JWT payload
 * carries `{ address: string; sub: string }` where `sub` is the dApp ID; it is
 * used as the default `dappId` for list queries.
 */
@ApiTags('Webhook Subscriptions')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('webhooks/subscriptions')
export class WebhookSubscriptionController {
  constructor(private readonly subscriptionService: WebhookSubscriptionService) {}

  // ── POST /webhooks/subscriptions ─────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a webhook subscription',
    description:
      'Register an https endpoint to receive webhook events for a dApp. ' +
      'Supply an optional HMAC-SHA256 `secret` (≥16 chars) — outgoing payloads are ' +
      'signed in the `X-TrustFlow-Signature` header for independent verification. ' +
      'The secret is stored for signing and returned only in masked form.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['dappId', 'url', 'topics'],
      properties: {
        dappId: { type: 'string', minLength: 1, example: 'dapp-abc-123' },
        url: {
          type: 'string',
          format: 'uri',
          example: 'https://example.com/hooks/trustflow',
          description: 'Destination endpoint URL (https only)',
        },
        topics: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          example: ['escrow.created', 'dispute.raised'],
          description: 'Event topics to subscribe to; use ["*"] for all events',
        },
        secret: {
          type: 'string',
          minLength: 16,
          example: 'my-super-secret-value',
          description: 'Optional HMAC secret (≥16 chars) for request signing',
        },
      },
    },
  })
  @ApiResponse({ status: 201, type: WebhookSubscriptionResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid dappId, URL, topics, or secret' })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  async create(
    @Body() body: unknown,
    @Req() req: Request & { user: { sub: string } },
  ): Promise<WebhookSubscriptionResponseDto> {
    let parsed;
    try {
      parsed = CreateWebhookSubscriptionSchema.parse(body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(
          err.errors[0]?.message ?? 'Invalid webhook subscription payload',
        );
      }
      throw err;
    }
    // Force dappId to the authenticated caller — never trust the request body.
    const sub = await this.subscriptionService.create({ ...parsed, dappId: req.user.sub });
    return this.toResponseDto(sub);
  }

  // ── GET /webhooks/subscriptions ──────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary: 'List webhook subscriptions for a dApp',
    description:
      'Returns subscriptions owned by the dApp given in the `dappId` query param, ' +
      'defaulting to the dApp ID (`sub`) of the authenticated JWT when omitted.',
  })
  @ApiQuery({
    name: 'dappId',
    required: false,
    description: 'DApp ID to filter by — defaults to the JWT subject when omitted',
  })
  @ApiOkResponse({ type: [WebhookSubscriptionResponseDto] })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  async findAll(
    @Query('dappId') dappId: string | undefined,
    @Req() req: Request & { user: { sub: string } },
  ): Promise<WebhookSubscriptionResponseDto[]> {
    const callerDappId = req.user.sub;
    // Reject attempts to list another dApp's subscriptions.
    if (dappId && dappId.trim() !== callerDappId) {
      throw new ForbiddenException('You can only list your own webhook subscriptions');
    }
    const subs = this.subscriptionService.listByDapp(callerDappId);
    return subs.map(s => this.toResponseDto(s));
  }

  // ── GET /webhooks/subscriptions/:id ─────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Get a webhook subscription by ID' })
  @ApiParam({ name: 'id', description: 'Subscription UUID' })
  @ApiOkResponse({ type: WebhookSubscriptionResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async findOne(
    @Param('id') id: string,
    @Req() req: Request & { user: { sub: string } },
  ): Promise<WebhookSubscriptionResponseDto> {
    const sub = this.subscriptionService.getById(id);
    if (!sub) {
      throw new NotFoundException(`Webhook subscription ${id} not found`);
    }
    if (sub.dappId !== req.user.sub) {
      throw new ForbiddenException('You do not own this webhook subscription');
    }
    return this.toResponseDto(sub);
  }

  // ── PATCH /webhooks/subscriptions/:id ───────────────────────────────────────

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a webhook subscription',
    description:
      'Partially update a subscription. All fields are optional but at least one ' +
      'must be provided — omit any field to leave it unchanged. To rotate the ' +
      'secret, supply a new `secret` value (≥16 chars).',
  })
  @ApiParam({ name: 'id', description: 'Subscription UUID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        dappId: { type: 'string', minLength: 1 },
        url: { type: 'string', format: 'uri', description: 'New destination URL (https only)' },
        topics: { type: 'array', items: { type: 'string' }, minItems: 1 },
        secret: { type: 'string', minLength: 16, description: 'New HMAC secret (≥16 chars)' },
      },
    },
  })
  @ApiOkResponse({ type: WebhookSubscriptionResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid field values or empty payload' })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request & { user: { sub: string } },
  ): Promise<WebhookSubscriptionResponseDto> {
    const existing = this.subscriptionService.getById(id);
    if (!existing) {
      throw new NotFoundException(`Webhook subscription ${id} not found`);
    }
    if (existing.dappId !== req.user.sub) {
      throw new ForbiddenException('You do not own this webhook subscription');
    }
    try {
      const parsed = UpdateWebhookSubscriptionSchema.parse(body);
      // Prevent reassigning a subscription to a different dApp.
      if (parsed.dappId !== undefined && parsed.dappId !== req.user.sub) {
        throw new ForbiddenException('Cannot reassign a subscription to a different dApp');
      }
      const sub = await this.subscriptionService.update(id, parsed);
      return this.toResponseDto(sub);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(
          err.errors[0]?.message ?? 'Invalid update payload',
        );
      }
      throw err;
    }
  }

  // ── DELETE /webhooks/subscriptions/:id ──────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a webhook subscription' })
  @ApiParam({ name: 'id', description: 'Subscription UUID' })
  @ApiOkResponse({
    description: 'Subscription deleted',
    schema: {
      type: 'object',
      properties: {
        deleted: { type: 'boolean', example: true },
        id: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async remove(
    @Param('id') id: string,
    @Req() req: Request & { user: { sub: string } },
  ): Promise<{ deleted: boolean; id: string }> {
    const existing = this.subscriptionService.getById(id);
    if (!existing) {
      throw new NotFoundException(`Webhook subscription ${id} not found`);
    }
    if (existing.dappId !== req.user.sub) {
      throw new ForbiddenException('You do not own this webhook subscription');
    }
    this.subscriptionService.remove(id);
    return { deleted: true, id };
  }

  // ── POST /webhooks/subscriptions/:id/ping ───────────────────────────────────

  @Post(':id/ping')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Test webhook endpoint reachability',
    description:
      'Sends a test POST to the subscription endpoint and reports whether it responded ' +
      'within 5 seconds. The payload `{ type: "ping", timestamp, subscriptionId }` is ' +
      'signed with the `X-TrustFlow-Signature` header when the subscription has a secret.',
  })
  @ApiParam({ name: 'id', description: 'Subscription UUID' })
  @ApiOkResponse({
    description: 'Ping result',
    schema: {
      type: 'object',
      properties: {
        reachable: {
          type: 'boolean',
          description: 'True when the endpoint responded with a 2xx status',
          example: true,
        },
        responseTimeMs: { type: 'number', description: 'Round-trip time in ms', example: 143 },
        statusCode: {
          type: 'number',
          description: 'HTTP status code returned by the endpoint (when reached)',
          example: 200,
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid JWT' })
  @ApiResponse({ status: 404, description: 'Subscription not found' })
  async ping(
    @Param('id') id: string,
    @Req() req: Request & { user: { sub: string } },
  ): Promise<WebhookSubscriptionPingResult> {
    const existing = this.subscriptionService.getById(id);
    if (!existing) {
      throw new NotFoundException(`Webhook subscription ${id} not found`);
    }
    if (existing.dappId !== req.user.sub) {
      throw new ForbiddenException('You do not own this webhook subscription');
    }
    return this.subscriptionService.ping(id);
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private toResponseDto(sub: WebhookSubscription): WebhookSubscriptionResponseDto {
    return {
      id: sub.id,
      dappId: sub.dappId,
      url: sub.url,
      topics: [...sub.topics],
      ...(sub.secret ? { secret: maskSecret(sub.secret) } : {}),
      createdAt: sub.createdAt.toISOString(),
      updatedAt: sub.updatedAt.toISOString(),
    };
  }
}
