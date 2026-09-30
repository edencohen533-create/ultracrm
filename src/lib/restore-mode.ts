import { ApiError } from "@/lib/response";

/**
 * A copy restored from backup runs with RESTORE_MODE=1: no scheduled jobs, no dialing, no sending, no charging – so
 * inspecting restored data can never act on real customers or money.
 */
export const restoreMode = () => process.env.RESTORE_MODE === "1";
export function assertNotRestoreMode(action: string) {
  if (restoreMode()) throw new ApiError(`סביבת שחזור – ${action} חסום`, 423, "restore_mode");
}
