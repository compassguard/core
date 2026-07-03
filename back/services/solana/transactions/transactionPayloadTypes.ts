export type Base64VersionedTransactionPayload = {
	encoding: "base64";
	actionHash: string;
	unsignedVersionedTransaction: string;
};