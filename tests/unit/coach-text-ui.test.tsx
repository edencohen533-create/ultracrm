import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/client/api", () => ({ api: { post: mock.post } }));
import { TextTraining } from "@/components/coach/SalesCoach";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("saves a text lesson into the review pipeline", async () => {
  mock.post.mockResolvedValue({ id: "i1", status: "candidate" }); const saved = vi.fn();
  render(<TextTraining t={(he) => he} onSaved={saved} />);
  fireEvent.change(screen.getByLabelText("כותרת"), { target: { value: "בירור התלבטות" } });
  fireEvent.change(screen.getByLabelText("מה ללמד את המאמן"), { target: { value: "שאלו מה חסר ללקוח כדי לקבל החלטה" } });
  fireEvent.click(screen.getByRole("button", { name: "שמירה והמשך לסקירה" }));
  await waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(mock.post).toHaveBeenCalledWith("/api/coach/insights", { title: "בירור התלבטות", body: "שאלו מה חסר ללקוח כדי לקבל החלטה", kind: "objection", objection: "" });
});
it("retains the entered text when saving fails", async () => {
  mock.post.mockRejectedValue(new Error("שמירה נכשלה")); const saved = vi.fn();
  render(<TextTraining t={(he) => he} onSaved={saved} />);
  fireEvent.change(screen.getByLabelText("כותרת"), { target: { value: "כותרת" } });
  fireEvent.change(screen.getByLabelText("מה ללמד את המאמן"), { target: { value: "תוכן חשוב" } });
  fireEvent.click(screen.getByRole("button", { name: "שמירה והמשך לסקירה" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("שמירה נכשלה");
  expect(screen.getByLabelText("מה ללמד את המאמן")).toHaveValue("תוכן חשוב"); expect(saved).not.toHaveBeenCalled();
});
