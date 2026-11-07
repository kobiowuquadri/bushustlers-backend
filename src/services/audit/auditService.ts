import type { Transaction } from 'sequelize';
import { AuditEvent } from '../../schemas/index.js';
import type { ActorType } from '../../schemas/audit/auditEventSchema.js';

export interface Actor {
  type: ActorType;
  id?: number | null;
}

export interface AuditInput {
  businessId: number | null;
  orderId?: number | null;
  entityType: 'order' | 'payment_attempt' | 'payment_link' | 'settlement' | 'business' | 'customer' | 'user';
  entityId?: number | null;
  action: string;
  actor: Actor;
  fromStatus?: string | null;
  toStatus?: string | null;
  metadata?: Record<string, unknown> | null;
  requestId?: string | null;
}

// Record a state change. Pass the surrounding transaction so history and state commit together.
export const recordAudit = (input: AuditInput, transaction?: Transaction) =>
  AuditEvent.create(
    {
      businessId: input.businessId,
      orderId: input.orderId ?? null,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      action: input.action,
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      metadata: input.metadata ?? null,
      requestId: input.requestId ?? null,
    },
    { transaction },
  );
