import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CallDto } from "@/lib/client/types";

vi.mock("@/components/dialer/WrapUpStatus", async (orig) => ({
  ...(await orig<typeof import("@/components/dialer/WrapUpStatus")>()),
  useWrapUpStatuses: () => ({ wrapUp: [{ id: "st-contacted", label: "נוצר קשר", kind: "contacted", isSystem: true, active: true, sortOrder: 0 }] }),
}));
vi.mock("@/components/dialer/useHotkeys", () => ({ useHotkeys: () => undefined }));
const { OutcomePanel } = await import("@/components/dialer/OutcomePanel");
afterEach(cleanup);

const call = (over: Partial<CallDto> = {}) => ({ id: "c1", answeredAt: null, telephonyResult: null, createdAt: new Date().toISOString(), endedAt: new Date().toISOString(), talkSeconds: 0, ...over }) as unknown as CallDto;
const statusBtn = () => screen.getByTestId("outcome-statuses").querySelector("button")!;

it("a provider result that arrives after the agent picked a status doesn't clear the pick", () => {
  const { rerender } = render(<OutcomePanel call={call()} note="" onSave={vi.fn()} saving={false} />);
  fireEvent.click(statusBtn());
  expect(statusBtn()).toHaveAttribute("data-sel", "true");
  rerender(<OutcomePanel call={call({ telephonyResult: "no_answer" })} note="" onSave={vi.fn()} saving={false} />); // late webhook
  expect(statusBtn()).toHaveAttribute("data-sel", "true");
  expect(screen.getByTestId("outcome-save")).not.toBeDisabled();
});

it("a late result fills the default when nothing was picked; a new call starts fresh", () => {
  const { rerender } = render(<OutcomePanel call={call()} note="" onSave={vi.fn()} saving={false} />);
  rerender(<OutcomePanel call={call({ telephonyResult: "busy" })} note="" onSave={vi.fn()} saving={false} />);
  expect(screen.getByTestId("outcome-save")).not.toBeDisabled(); // "busy" pre-selected
  fireEvent.click(statusBtn());
  rerender(<OutcomePanel call={call({ id: "c2", telephonyResult: null })} note="" onSave={vi.fn()} saving={false} />);
  expect(statusBtn()).toHaveAttribute("data-sel", "false");
  expect(screen.getByTestId("outcome-save")).toBeDisabled();
});
