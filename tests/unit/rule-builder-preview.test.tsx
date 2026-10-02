import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RuleBuilder } from "@/components/automations/rule-builder";
import { automationRuleSchema } from "@/lib/validation/automation";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/client/use-lead-statuses", () => ({ useLeadStatuses: () => [] }));
vi.mock("@/components/automations/journey/journey-ai", () => ({ JourneyAiPanel: () => null }));
// Test the form/request contract; the menu primitive itself is exercised in the real browser.
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const Change = React.createContext<(v: string) => void>(() => {});
  return {
    Select: ({ children, onValueChange }: { children: React.ReactNode; onValueChange: (v: string) => void }) => <Change.Provider value={onValueChange}>{children}</Change.Provider>,
    SelectTrigger: ({ children, ...props }: React.ComponentProps<"button">) => <button {...props} role="combobox">{children}</button>,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectValue: () => null,
    SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => { const change = React.useContext(Change); return <button role="option" aria-selected={false} onClick={() => change(value)}>{children}</button>; },
  };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openDraft() {
  render(<RuleBuilder agents={[]} cannedReplies={[]} templates={[]} conversations={[{ id: "conversation", label: "Test conversation" }]} />);
  fireEvent.click(screen.getByRole("button", { name: "חוק אוטומציה חדש" }));
  fireEvent.change(screen.getByLabelText("שם חוק האוטומציה"), { target: { value: "Test rule" } });
  fireEvent.click(screen.getByRole("combobox", { name: "פעולת האוטומציה" }));
  const option = await screen.findByRole("option", { name: "הוספת הערה פנימית" });
  fireEvent.mouseDown(option); fireEvent.mouseUp(option); fireEvent.click(option);
  fireEvent.change(await screen.findByLabelText("תוכן ההערה האוטומטית"), { target: { value: "Internal test note" } });
  fireEvent.change(screen.getByLabelText("שיחה לבדיקת אוטומציה"), { target: { value: "conversation" } });
}
it("dry run submits a complete server-valid rule and shows the result", async () => {
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    const payload = JSON.parse(String(init.body));
    expect(automationRuleSchema.safeParse(payload.rule).success).toBe(true);
    expect(payload.rule.isActive).toBe(false);
    return { ok: true, json: async () => ({ allowedLocally: true, reasons: [], body: null, provider: "No send", notice: "No changes made", delayMinutes: 0 }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  await openDraft(); fireEvent.click(screen.getByRole("button", { name: "בדוק ללא ביצוע" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("הבדיקות המקומיות עברו"));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("a failed dry run keeps a visible error inside the dialog", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "השיחה אינה נגישה" }) })));
  await openDraft(); fireEvent.click(screen.getByRole("button", { name: "בדוק ללא ביצוע" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("השיחה אינה נגישה"));
});
