import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";
// The database client is never used in unit tests, but importing it requires a URL.
process.env.DATABASE_URL ??= "postgresql://unit:unit@localhost:5432/unit";
// Unit tests never touch the database or a business scope.
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<object>()), requireBusinessId: () => "test-business" }));
