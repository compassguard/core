export type MagicBlockBearerAuthorization = {
	readonly authorize: (authorizationHeader: string | null) => boolean;
};
