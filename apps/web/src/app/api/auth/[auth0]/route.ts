import { NextRequest, NextResponse } from "next/server";
import { auth0, auth0Configured, safeReturnTo } from "@/lib/auth0";
import { clearTokens, failure, setTokens, upstream } from "@/lib/server";
import type { AfterCallbackAppRoute } from "@auth0/nextjs-auth0";

export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  context: { params: { auth0: string } },
) {
  if (!auth0Configured())
    return failure(
      503,
      "Auth0 is not configured. Complete the website’s Auth0 environment settings first.",
    );
  const sdk = auth0();
  const handle = sdk.handleAuth({
    login: sdk.handleLogin((req) => ({
      returnTo: safeReturnTo(
        new URL(req.url!, process.env.AUTH0_BASE_URL).searchParams.get(
          "returnTo",
        ),
      ),
    })),
    signup: sdk.handleLogin((req) => ({
      returnTo: safeReturnTo(
        new URL(req.url!, process.env.AUTH0_BASE_URL).searchParams.get(
          "returnTo",
        ),
        "/onboard",
      ),
      authorizationParams: { screen_hint: "signup" },
    })),
    async callback(
      req: NextRequest,
      ctx: { params: Record<string, string | string[]> },
    ) {
      let tokens: { accessToken: string; refreshToken: string } | undefined;
      const afterCallback: AfterCallbackAppRoute = async (
        _request,
        session,
        state,
      ) => {
        const destination = safeReturnTo(state?.returnTo);
        delete session.locogiUserId;
        session.locogiReturnTo = destination;
        session.locogiBridgeError = undefined;
        try {
          if (!session.accessToken) throw new Error("MISSING_API_TOKEN");
          const source = await upstream("/auth/social", {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}` },
            body: "{}",
          });
          const data = await source.json().catch(() => ({}));
          if (
            source.ok &&
            typeof data.userId === "string" &&
            typeof data.accessToken === "string" &&
            typeof data.refreshToken === "string"
          ) {
            tokens = data;
            session.locogiUserId = data.userId;
          } else
            session.locogiBridgeError =
              data.code === "PHONE_LINK_REQUIRED"
                ? "PHONE_LINK_REQUIRED"
                : "EXCHANGE_UNAVAILABLE";
        } catch {
          session.locogiBridgeError = "EXCHANGE_UNAVAILABLE";
        }
        if (state)
          state.returnTo = session.locogiUserId
            ? destination
            : `/account/link?returnTo=${encodeURIComponent(destination)}`;
        return session;
      };
      const response = (await sdk.handleCallback(req, ctx, {
        afterCallback,
      })) as NextResponse;
      clearTokens(response);
      if (tokens) setTokens(response, tokens);
      response.headers.set("Cache-Control", "no-store");
      return response;
    },
    async logout(
      req: NextRequest,
      ctx: { params: Record<string, string | string[]> },
    ) {
      const response = (await sdk.handleLogout(req, ctx, {
        returnTo: process.env.AUTH0_BASE_URL,
      })) as NextResponse;
      clearTokens(response);
      return response;
    },
    onError() {
      return NextResponse.redirect(
        new URL("/login?error=auth0", process.env.AUTH0_BASE_URL),
      );
    },
  });
  return handle(request, context);
}
