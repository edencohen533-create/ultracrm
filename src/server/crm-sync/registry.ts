import type { ConnectorDef } from "./types";
import { genericConnector } from "./connectors/generic";
import { simulatorConnector } from "./connectors/simulator";

/**
 * Connectors that exist in this codebase. No vendor connector is listed until it is built and tested against the
 * vendor's documented API – the business sees only what really works. The simulator is for tests / local QA only.
 */
const ALL: ConnectorDef[] = [genericConnector, simulatorConnector];
const simulatorEnabled = () => process.env.CRM_SIMULATOR === "1" || process.env.VITEST === "true" || process.env.NODE_ENV === "test";
export function connectorFor(key: string): ConnectorDef | null { const c = ALL.find((x) => x.key === key) ?? null; return c && c.internal && !simulatorEnabled() ? null : c; }
export function visibleConnectors() { return ALL.filter((c) => !c.internal || simulatorEnabled()); }
