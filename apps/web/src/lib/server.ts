import "server-only";
import { NextRequest, NextResponse } from "next/server";

export const ACCESS_COOKIE = "locogi_access";
export const REFRESH_COOKIE = "locogi_refresh";
export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export function checkOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  return (
    !!origin && origin === (process.env.APP_ORIGIN || request.nextUrl.origin)
  );
}
export async function upstream(
  path: string,
  options: RequestInit = {},
  timeout = 20000,
) {
  if (
    process.env.VERCEL === "1" &&
    (!process.env.API_URL ||
      /^(https?:\/\/)?(localhost|127\.0\.0\.1)(:|\/|$)/i.test(
        process.env.API_URL,
      ))
  )
    throw new Error("A hosted API_URL must be configured for this deployment.");
  const base = (process.env.API_URL || "http://localhost:3001").replace(
    /\/$/,
    "",
  );
  const prefix = (process.env.API_PREFIX || "/api/v1").replace(/\/$/, "");
  return fetch(`${base}${prefix}${path}`, {
    ...options,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": crypto.randomUUID(),
      ...options.headers,
    },
  });
}
export function failure(
  status = 503,
  message = "Locogi API is unavailable. Check that it is running, then retry.",
) {
  return NextResponse.json(
    { message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
export function setTokens(
  response: NextResponse,
  data: { accessToken: string; refreshToken: string },
) {
  response.cookies.set(ACCESS_COOKIE, data.accessToken, {
    ...cookieOptions,
    maxAge: 15 * 60,
  });
  response.cookies.set(REFRESH_COOKIE, data.refreshToken, {
    ...cookieOptions,
    maxAge: 30 * 86400,
  });
}
export function clearTokens(response: NextResponse) {
  response.cookies.set(ACCESS_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  response.cookies.set(REFRESH_COOKIE, "", { ...cookieOptions, maxAge: 0 });
}
export function traced(response: NextResponse, source: Response) {
  response.headers.set("Cache-Control", "no-store");
  const correlation = source.headers.get("x-correlation-id");
  if (correlation) response.headers.set("x-correlation-id", correlation);
  return response;
}
