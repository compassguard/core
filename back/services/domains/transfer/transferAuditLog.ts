import type { TransferAuditEvent } from './transferGatewayContracts';

const MAX_TRANSFER_AUDIT_EVENTS = 500;

const transferAuditRuntime = globalThis as typeof globalThis & {
  __compassTransferAuditEvents?: TransferAuditEvent[];
};

const events = transferAuditRuntime.__compassTransferAuditEvents ??= [];

export function recordTransferAuditEvent(event: TransferAuditEvent): void {
  events.push(event);
  if (events.length > MAX_TRANSFER_AUDIT_EVENTS) {
    events.splice(0, events.length - MAX_TRANSFER_AUDIT_EVENTS);
  }
}

export function getTransferAuditEvents(): TransferAuditEvent[] {
  return [...events];
}

export function clearTransferAuditEvents(): void {
  events.length = 0;
}