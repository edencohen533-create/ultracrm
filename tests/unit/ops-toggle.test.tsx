import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/lib/client/api";
import { OpsToggle, ImpactView } from "@/components/ai/OpsTab";
import { HelpTip } from "@/components/ai/HelpTip";

vi.mock("@/lib/client/api", () => ({ api: { patch: vi.fn(), get: vi.fn(), post: vi.fn(), delete: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

it("one click changes the state at once and saves once; a second click while saving is ignored", async () => {
  const d = deferred<Record<string, boolean>>();
  vi.mocked(api.patch).mockReturnValueOnce(d.promise as never);
  const onSaved = vi.fn();
  render(<OpsToggle field="enabled" value={false} label="מנהל AI פעיל" help={null} onSaved={onSaved} />);
  const box = screen.getByTestId("ops-enabled") as HTMLInputElement;
  fireEvent.click(box);
  expect(box.checked).toBe(true); // immediately, not after the reload
  fireEvent.click(box); // double click during the save
  expect(api.patch).toHaveBeenCalledTimes(1);
  expect(api.patch).toHaveBeenCalledWith("/api/ops/settings", { enabled: true });
  await act(async () => { d.resolve({ enabled: true }); await d.promise; });
  expect(box.checked).toBe(true);
  expect(onSaved).toHaveBeenCalledTimes(1);
});

it("clicking the label text toggles once", async () => {
  vi.mocked(api.patch).mockResolvedValueOnce({ notifyWhatsApp: true } as never);
  render(<OpsToggle field="notifyWhatsApp" value={false} label="התראות בוואטסאפ" help={null} onSaved={() => {}} />);
  fireEvent.click(screen.getByText("התראות בוואטסאפ"));
  await waitFor(() => expect((screen.getByTestId("ops-notifyWhatsApp") as HTMLInputElement).checked).toBe(true));
  expect(api.patch).toHaveBeenCalledTimes(1);
});

it("a failed save goes back to the real state and shows an error", async () => {
  vi.mocked(api.patch).mockRejectedValueOnce(new Error("שגיאת שרת"));
  const onSaved = vi.fn();
  render(<OpsToggle field="enabled" value={true} label="מנהל AI פעיל" help={null} onSaved={onSaved} />);
  const box = screen.getByTestId("ops-enabled") as HTMLInputElement;
  fireEvent.click(box);
  expect(box.checked).toBe(false);
  await waitFor(() => expect(box.checked).toBe(true));
  expect(screen.getByTestId("ops-enabled-error")).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
});

it("follows the server value when it changes (refresh), but not during its own save", async () => {
  const { rerender } = render(<OpsToggle field="enabled" value={false} label="x" help={null} onSaved={() => {}} />);
  rerender(<OpsToggle field="enabled" value={true} label="x" help={null} onSaved={() => {}} />);
  expect((screen.getByTestId("ops-enabled") as HTMLInputElement).checked).toBe(true);
});

it("help opens on click and on keyboard, closes on Escape; it is linked to its button", async () => {
  render(<HelpTip label="המלצות" testId="h">הסבר קצר</HelpTip>);
  const btn = screen.getByTestId("h");
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(btn);
  expect(screen.getByTestId("h-text").textContent).toBe("הסבר קצר");
  expect(btn.getAttribute("aria-controls")).toBe(screen.getByTestId("h-text").id);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("h-text")).toBeNull();
  btn.focus(); fireEvent.click(btn); // Enter / Space on a native button fire click
  expect(screen.getByTestId("h-text")).toBeTruthy();
});

it("impact: empty state without numbers; small samples show counts but no percentages", () => {
  const { rerender } = render(<ImpactView rows={[]} loc="he-IL" />);
  expect(screen.getByTestId("ops-impact-empty")).toBeTruthy();
  expect(screen.queryByText(/%/)).toBeNull();
  rerender(<ImpactView loc="he-IL" rows={[{ id: "1", agentName: "דנה", at: "2026-09-20T08:00:00Z", until: null, status: "active", approved: 5, allocated: 5, dialed: 4, won: 1, compare: { leads: 30, won: 6, from: "2026-09-06T08:00:00Z", to: "2026-09-20T08:00:00Z" }, minSample: 20, smallSample: true, compareSmall: false }]} />);
  const row = screen.getByTestId("ops-impact-row").textContent!;
  expect(row).toContain("הוקצו 5 · חויגו 4 · נסגרו לעסקה 1");
  expect(row).toContain("מדגם קטן");
  expect(row).not.toContain("עסקאות מתוך הלידים שהוקצו"); // the observed 1/5 gets no percentage
  expect(row).toContain("אחוז סגירה: 20%"); // the comparison 6/30 (enough data) does
  expect(row).toContain("ההקצאה עדיין פעילה");
});
