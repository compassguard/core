export type BunServeConfig = {
	port: number;
	fetch: (request: Request) => Response | Promise<Response>;
};

export type BunRuntime = {
	serve: (config: BunServeConfig) => unknown;
};
