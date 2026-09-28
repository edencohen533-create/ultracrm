import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UnsubscribeCard } from "@/components/automations/unsubscribe-card";
import { api } from "@/lib/client/api";
vi.mock("@/lib/client/api", () => ({ api: { get: vi.fn(async () => ({ removeFromLists: false, tagName: null })), patch: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("a slow checkbox save cannot erase a newer tag or overwrite its subsequent save", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api.patch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockImplementationOnce(async (_url, data) => data);
  render(<UnsubscribeCard />);
  fireEvent.click(await screen.findByTestId("unsub-remove-lists"));
  await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByTestId("unsub-tag"), { target: { value: "Opted out" } });
  await act(async () => finish({ removeFromLists: true, tagName: null }));
  expect(screen.getByTestId("unsub-tag")).toHaveValue("Opted out");
  fireEvent.blur(screen.getByTestId("unsub-tag"));
  await waitFor(() => expect(api.patch).toHaveBeenLastCalledWith("/api/automations/unsubscribe-settings", { removeFromLists: true, tagName: "Opted out" }));
});
