import type {
	MagicBlockMcpAuditClient,
	MagicBlockMcpObserver,
} from "./magicBlockMcpObserverContracts";

export function createMagicBlockMcpObserver(input: {
	readonly auditClient: MagicBlockMcpAuditClient;
}): MagicBlockMcpObserver {
	return (observation) => input.auditClient.observe(observation);
}
