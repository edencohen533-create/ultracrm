import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DealCloseModal } from "@/components/leads/DealCloseModal";
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
afterEach(cleanup);
it("clearing a purchase date keeps the form usable and prevents saving an incomplete product", () => {
  render(<DealCloseModal contactId="contact" name="QA" onClose={vi.fn()} onDone={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("מוצר"), { target: { value: "Monthly service" } });
  expect(() => fireEvent.change(screen.getByLabelText("תאריך רכישה"), { target: { value: "" } })).not.toThrow();
  expect(screen.getByTestId("deal-close")).toBeInTheDocument();
  expect(screen.getByTestId("deal-close-save")).toBeDisabled();
});
it("a one-month purchase on January 31 renews on the last day of February", () => {
  render(<DealCloseModal contactId="contact" name="QA" onClose={vi.fn()} onDone={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("תאריך רכישה"), { target: { value: "2027-01-31" } });
  fireEvent.change(screen.getByLabelText("משך"), { target: { value: "1" } });
  expect(screen.getByText(/מסתיים ב-/)).toHaveTextContent("28.02.2027");
});
