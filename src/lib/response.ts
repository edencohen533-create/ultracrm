import { NextResponse } from "next/server";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ success: true, data }, { status });
}

export function fail(message: string, status = 400, details?: unknown, code?: string) {
  return NextResponse.json(
    { success: false, error: message, ...(code ? { code } : {}), ...(details ? { details } : {}) },
    { status },
  );
}

export const unauthorized = (m = "לא מחובר") => fail(m, 401, undefined, "unauthorized");
export const forbidden = (m = "אין הרשאה לפעולה זו") => fail(m, 403, undefined, "forbidden");
export const notFound = (m = "לא נמצא") => fail(m, 404, undefined, "not_found");
export const conflict = (m: string, details?: unknown) => fail(m, 409, details, "conflict");

/** Errors thrown by services carry an HTTP status + stable code for the UI. */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(message: string, status = 400, code = "bad_request", details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function handleError(err: unknown) {
  if (err instanceof ApiError) return fail(err.message, err.status, err.details, err.code);
  console.error("[api] unhandled error", err);
  return fail("שגיאת שרת", 500, undefined, "server_error");
}
