import { NextRequest, NextResponse } from "next/server";
import { auth0, safeReturnTo, websiteSession, websiteToken } from "@/lib/auth0";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  checkOrigin,
  clearTokens,
  failure,
  setTokens,
  traced,
  upstream,
} from "@/lib/server";

export const dynamic = "force-dynamic";
export async function POST(
  request: NextRequest,
  { params }: { params: { action: string } },
) {
  if (!checkOrigin(request))
    return failure(403, "Cross-origin request refused.");
  if (
    !["send-link-otp", "link", "exchange", "refresh", "logout"].includes(
      params.action,
    )
  )
    return failure(404, "Not found.");
  try {
    if (params.action === "logout") {
      const response = NextResponse.json({ success: true });
      clearTokens(response);
      return response;
    }
    const session = await websiteSession(request);
    if (!session) return failure(401, "Sign in with Auth0 first.");
    if (params.action === "send-link-otp") {
      const input = await request.json();
      const source = await upstream("/auth/send-otp", {
        method: "POST",
        body: JSON.stringify({ phone: input.phone }),
      });
      if (!source.ok)
        return traced(
          failure(
            source.status,
            "Could not send the verification code. Check the number or wait before retrying.",
          ),
          source,
        );
      return traced(NextResponse.json({ success: true }), source);
    }
    if (params.action === "link" || params.action === "exchange") {
      const response = NextResponse.json({
        success: true,
        returnTo: safeReturnTo(session.locogiReturnTo),
      });
      const { accessToken } = await auth0().getAccessToken(request, response);
      if (!accessToken)
        return failure(
          401,
          "Your Auth0 API session has expired. Sign in again.",
        );
      let localProof: string | undefined;
      if (params.action === "link") {
        const input = await request.json();
        if (input.confirmLink !== true)
          return failure(400, "Confirm that you want to link these accounts.");
        const verified = await upstream("/auth/verify-otp", {
          method: "POST",
          body: JSON.stringify({ phone: input.phone, otp: input.otp }),
        });
        if (!verified.ok)
          return traced(
            failure(
              verified.status,
              "The phone verification code is incorrect, expired, or rate limited.",
            ),
            verified,
          );
        const proof = await verified.json();
        localProof = proof.accessToken;
        if (typeof localProof !== "string")
          return failure(
            502,
            "Phone verification returned an incomplete response.",
          );
      }
      const source = await upstream("/auth/social", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(
          localProof ? { locogiAccessToken: localProof } : {},
        ),
      });
      const data = await source.json().catch(() => ({}));
      if (!source.ok)
        return traced(
          failure(
            source.status,
            data.code === "PHONE_LINK_REQUIRED"
              ? "Verify your phone once to connect your Locogi account."
              : "The accounts could not be linked. Check the API’s Auth0 configuration or contact support.",
          ),
          source,
        );
      if (
        typeof data.userId !== "string" ||
        typeof data.accessToken !== "string" ||
        typeof data.refreshToken !== "string"
      )
        return failure(502, "The token exchange response was incomplete.");
      const updatedSession = await auth0().getSession(request, response);
      if (!updatedSession) return failure(401, "Your Auth0 session expired.");
      await auth0().updateSession(request, response, {
        ...updatedSession,
        locogiUserId: data.userId,
        locogiBridgeError: undefined,
      });
      setTokens(response, data);
      return traced(response, source);
    }
    if (!session.locogiUserId)
      return failure(409, "Link your verified phone to continue.");
    const body = { refreshToken: request.cookies.get(REFRESH_COOKIE)?.value };
    if (params.action === "refresh" && !body.refreshToken)
      return failure(401, "Please sign in.");
    const source = await upstream("/auth/refresh", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const data = await source.json().catch(() => ({}));
    if (!source.ok) {
      const response = traced(
        failure(
          source.status,
          source.status >= 500
            ? "Authentication service unavailable."
            : "Sign-in failed. Check your phone and code, then try again.",
        ),
        source,
      );
      if (params.action === "refresh" && source.status === 401)
        clearTokens(response);
      return response;
    }
    if (
      typeof data.accessToken !== "string" ||
      typeof data.refreshToken !== "string"
    )
      return failure(502, "The authentication response was incomplete.");
    const payload = JSON.parse(
      Buffer.from(data.accessToken.split(".")[1], "base64url").toString("utf8"),
    );
    if (payload.sub !== session.locogiUserId) {
      const response = failure(
        401,
        "The website and API sessions do not match. Sign in again.",
      );
      clearTokens(response);
      return response;
    }
    const response = traced(NextResponse.json({ success: true }), source);
    setTokens(response, data);
    return response;
  } catch {
    return failure();
  }
}
export async function GET(
  request: NextRequest,
  { params }: { params: { action: string } },
) {
  if (params.action !== "socket") return failure(404, "Not found.");
  if (request.headers.get("sec-fetch-site") === "cross-site")
    return failure(403, "Cross-origin request refused.");
  const token = await websiteToken(request);
  if (!token) return failure(401, "Please sign in.");
  return NextResponse.json(
    { token },
    { headers: { "Cache-Control": "no-store" } },
  );
}
