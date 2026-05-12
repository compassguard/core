import { describe, it } from 'vitest';

// TODO: Integration coverage for guarded_transfer is scaffolded here.
// This test suite should run against a deployed AgentActionGuard program and cover:
// - happy path guarded_transfer success.
// - rejection when ActionApproval mismatches recipient/amount/hash.
// - rejection when attestation missing or expired.
// - replay attempt when approval is already executed.
describe('agent-action-guard guarded_transfer', () => {
  it.skip('should execute guarded_transfer for matching action_hash, approval and attestation', () => {});
  it.skip('should reject mismatched amount or recipient before CPI transfer', () => {});
  it.skip('should reject when WalletSafetyAttestation is inactive or expired', () => {});
  it.skip('should reject replay when ActionApproval.executed is already true', () => {});
});
