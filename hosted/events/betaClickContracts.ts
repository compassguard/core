export const BETA_CLICK_SOURCES = ["nav", "hero", "closing", "unknown"] as const;

export type BetaClickSource = (typeof BETA_CLICK_SOURCES)[number];
