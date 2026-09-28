import { expect, it } from "vitest";
import { safeReturnPath } from "@/lib/navigation";

it.each([null, "", "https://example.com", "//example.com", "/\\example.com", "/\t/example.com", "/\n/example.com", "javascript:alert(1)"])("rejects external login redirect %j", (value) => {
  expect(safeReturnPath(value)).toBe("/");
});
it.each(["/contacts", "/leads?status=new#list", "/contacts?q=%D7%93%D7%A0%D7%94"])("preserves internal login redirect %s", (value) => {
  expect(safeReturnPath(value)).toBe(value);
});
