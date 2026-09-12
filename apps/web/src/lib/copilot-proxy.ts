import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { checkOrigin, failure } from "./server";
import { membership } from "./workspace-server";
import { websiteToken } from "./auth0";

export async function copilotStatus(request: NextRequest) {
  if (!(await websiteToken(request))) return failure(401, "Please sign in.");
  return NextResponse.json(
    {
      configured:
        !!process.env.NEXT_PUBLIC_COPILOT_CLOUD_PUBLIC_API_KEY ||
        !!process.env.COPILOTKIT_URL,
      available:
        !!process.env.COPILOTKIT_URL &&
        process.env.COPILOTKIT_REVIEWED === "true",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
export async function forwardCopilot(
  request: NextRequest,
  segments: string[] = [],
) {
  if (request.method === "POST" && !checkOrigin(request))
    return failure(403, "Cross-origin request refused.");
  if (request.method !== "GET" && request.method !== "POST")
    return failure(405, "Method not allowed.");
  if (
    segments.length > 4 ||
    segments.some((segment) => !/^[a-zA-Z0-9_-]+$/.test(segment))
  )
    return failure(404, "Runtime path unavailable.");
  const orgId = request.headers.get("x-org-id");
  if (!orgId) return failure(403, "A business context is required.");
  try {
    const access = await membership(request, orgId);
    if (!access) return failure(403, "Business membership is required.");
    const custom = process.env.COPILOTKIT_URL;
    const publicKey = process.env.NEXT_PUBLIC_COPILOT_CLOUD_PUBLIC_API_KEY;
    if (custom && process.env.COPILOTKIT_REVIEWED !== "true")
      return failure(
        501,
        "The custom runtime must be security-reviewed before use.",
      );
    if (!custom && !publicKey)
      return failure(501, "Configure Copilot Cloud or a reviewed runtime.");
    const target = new URL(
      custom || "https://api.cloud.copilotkit.ai/copilotkit/v1",
    );
    if (
      target.protocol !== "https:" &&
      !(
        process.env.NODE_ENV !== "production" &&
        ["localhost", "127.0.0.1"].includes(target.hostname)
      )
    )
      return failure(500, "The runtime requires a secure endpoint.");
    target.pathname =
      target.pathname.replace(/\/$/, "") +
      (segments.length ? `/${segments.join("/")}` : "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (publicKey) headers["X-CopilotCloud-Public-Api-Key"] = publicKey;
    if (custom) {
      headers.Authorization = `Bearer ${access.token}`;
      headers["x-org-id"] = access.member.id;
      headers["x-role"] = access.member.role;
      headers["x-user-id"] = JSON.parse(
        Buffer.from(access.token.split(".")[1], "base64url").toString("utf8"),
      ).sub;
    }
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && body.length > 1000000)
      return failure(
        413,
        "The copilot context is too large. Narrow the request.",
      );
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(55000),
    });
    if (!response.ok)
      return failure(
        response.status,
        "The Copilot runtime rejected this request. Check the Cloud key, allowed origins, and locogi-vendor-assistant agent configuration.",
      );
    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return failure(
      503,
      "The business copilot is unavailable. No business changes were simulated.",
    );
  }
}
