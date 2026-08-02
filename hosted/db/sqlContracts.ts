export type SqlExecutor = (
	text: string,
	params: readonly unknown[],
) => Promise<Record<string, unknown>[]>;
