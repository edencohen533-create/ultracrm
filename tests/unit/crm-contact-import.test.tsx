import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ContactsPage from "@/app/(app)/contacts/page";
import { api } from "@/lib/client/api";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/telephony/DialerProvider", () => ({ useDialer: () => ({ state: null, dial: vi.fn() }) }));
vi.mock("@/lib/client/use-me", () => ({ useMe: () => ({ user: { role: "owner" }, modules: {} }) }));
vi.mock("@/components/contacts/segments-panel", () => ({ SegmentsPanel: () => null }));
vi.mock("@/lib/client/api", () => ({ qs: () => "", api: { get: vi.fn(async () => ({ items: [], total: 0 })), post: vi.fn(async () => ({ created: 1, updated: 0, invalid: 0, errors: [] })) } }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("imports quoted names and embedded commas through the actual contacts form", async () => {
  render(<ContactsPage />);
  fireEvent.click(screen.getByRole("button", { name: "ייבוא CSV" }));
  fireEvent.change(screen.getByPlaceholderText(/^name,phone/), { target: { value: 'name,phone,company\n"Cohen, Dana",0501234567,"One, Two"' } });
  fireEvent.click(screen.getByRole("button", { name: /^ייבא$/ }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith("/api/contacts/import", expect.objectContaining({ rows: [expect.objectContaining({ fullName: "Cohen, Dana", phone: "0501234567", company: "One, Two" })] })));
});
