import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageComposer } from "@/components/inbox/message-composer";
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("message composer", () => {
  it("allows an approved template outside the free-text window and renders the confirmed send", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ body: "" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ templates: [{ id: "t", name: "welcome", body: "שלום {{1}}" }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { id: "m", body: "שלום דנה" } }) });
    vi.stubGlobal("fetch", fetchMock);
    const onSent = vi.fn();
    render(<MessageComposer conversationId="c" disabled onSent={onSent} />);
    expect(screen.queryByPlaceholderText("הקלד הודעה...")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "שליחת תבנית מאושרת" }));
    await screen.findByRole("option", { name: "welcome" });
    fireEvent.change(screen.getByLabelText("תבנית הודעה"), { target: { value: "t" } });
    fireEvent.change(screen.getByLabelText("משתנה 1"), { target: { value: "דנה" } });
    fireEvent.click(screen.getByRole("button", { name: "שלח" }));
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ id: "m", body: "שלום דנה" })));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual(expect.objectContaining({ templateId: "t", templateVariables: { "1": "דנה" }, requestId: expect.any(String) }));
  });
  it("keeps the message text when the provider rejects it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "rejected" }) }));
    const onSent = vi.fn();
    render(<MessageComposer conversationId="c" onSent={onSent} />);
    fireEvent.change(screen.getByPlaceholderText("הקלד הודעה..."), { target: { value: "שלום" } });
    fireEvent.click(screen.getByRole("button", { name: "שלח" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "שלח" })).toBeEnabled());
    expect(screen.getByPlaceholderText("הקלד הודעה...")).toHaveValue("שלום");
    expect(onSent).not.toHaveBeenCalled();
  });
});
it("does not let a delayed clear overwrite the next draft", async () => {
  let finishClear!: () => void;
  const clearPending = new Promise<void>((resolve) => { finishClear = resolve; });
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/messages")) return { ok: true, json: async () => ({ message: { id: "m", body: "first" } }) };
    if (options?.method === "PUT") {
      const body = JSON.parse(String(options.body)).body;
      writes.push(body);
      if (body === "") await clearPending;
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, json: async () => ({ body: "" }) };
  }));
  render(<MessageComposer conversationId="c" />);
  fireEvent.change(screen.getByPlaceholderText("הקלד הודעה..."), { target: { value: "first" } });
  fireEvent.click(screen.getByRole("button", { name: "שלח" }));
  await waitFor(() => expect(screen.getByPlaceholderText("הקלד הודעה...")).toHaveValue(""));
  fireEvent.change(screen.getByPlaceholderText("הקלד הודעה..."), { target: { value: "next draft" } });
  await new Promise((resolve) => setTimeout(resolve, 700));
  expect(writes).toEqual([""]);
  finishClear();
  await waitFor(() => expect(writes).toEqual(["", "next draft"]));
});

it("blocks sending after number disconnect while preserving the representative's draft", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ body: "" }) });
  vi.stubGlobal("fetch", fetchMock);
  const view = render(<MessageComposer conversationId="c" />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  fireEvent.change(screen.getByPlaceholderText("הקלד הודעה..."), { target: { value: "טיוטה שתישמר" } });
  view.rerender(<MessageComposer conversationId="c" senderUnavailable="המספר נותק" />);
  expect(screen.getByRole("alert")).toHaveTextContent("המספר נותק");
  expect(screen.getByRole("button", { name: "שלח" })).toBeDisabled();
  fireEvent.keyDown(screen.getByPlaceholderText("הקלד הודעה..."), { key: "Enter" });
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/messages"))).toBe(false);
  view.rerender(<MessageComposer conversationId="c" senderUnavailable={null} />);
  expect(screen.getByPlaceholderText("הקלד הודעה...")).toHaveValue("טיוטה שתישמר");
  expect(screen.getByRole("button", { name: "שלח" })).toBeEnabled();
});
