import type { AudienceNode } from "./audiences";

/** Starting audience: everyone who opted in. Kept apart from the zod schemas so client screens stay light. */
export const defaultAudience = (): AudienceNode => ({ operator: "AND", conditions: [{ field: "consent", operator: "is", value: "OPTED_IN" }] });
