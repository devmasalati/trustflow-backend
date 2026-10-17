export enum OutboxEventState {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  DEAD_LETTER = 'DEAD_LETTER',
}

export enum OutboxEventType {
  ESCROW_CREATED = 'ESCROW_CREATED',
  ESCROW_RELEASED = 'ESCROW_RELEASED',
  DISPUTE_RAISED = 'DISPUTE_RAISED',
  DISPUTE_RESOLVED = 'DISPUTE_RESOLVED',
  EVIDENCE_SUBMITTED = 'EVIDENCE_SUBMITTED',
  MILESTONE_APPROVED = 'MILESTONE_APPROVED',
}

export class OutboxEvent {
  id!: string;
  eventType!: OutboxEventType;
  payload!: string;
  state!: OutboxEventState;
  attempts!: number;
  maxAttempts!: number;
  lastError?: string;
  createdAt!: Date;
  updatedAt!: Date;
  processedAt?: Date;
  deadLetteredAt?: Date;
}
