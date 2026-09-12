import { NextRequest, NextResponse } from "next/server";
import { websiteToken } from "@/lib/auth0";
import {
  ACCESS_COOKIE,
  checkOrigin,
  failure,
  traced,
  upstream,
} from "@/lib/server";
import { rememberPlatformKey } from "@/lib/workspace-server";

export async function POST(request: NextRequest) {
  if (!checkOrigin(request))
    return failure(403, "Cross-origin request refused.");
  const token = await websiteToken(request);
  if (!token) return failure(401, "Sign in before creating a business.");
  try {
    const input = await request.json();
    if (
      typeof input.description !== "string" ||
      input.description.trim().length < 10 ||
      input.description.length > 5000
    )
      return failure(400, "Describe your business in 10–5,000 characters.");
    const response = await upstream(
      "/platform/onboard",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          description: input.description,
          ...(input.city ? { city: input.city } : {}),
          ...(input.phone ? { phone: input.phone } : {}),
        }),
      },
      120000,
    );
    if (!response.ok)
      return traced(
        failure(
          response.status,
          "The API could not finish onboarding. Check My businesses before retrying; a lost response does not prove creation failed.",
        ),
        response,
      );
    const data = await response.json();
    if (typeof data.organizationId !== "string")
      return failure(
        502,
        "The API did not return a business identifier. Check My businesses before retrying.",
      );
    if (typeof data.apiKey === "string")
      rememberPlatformKey(data.organizationId, data.apiKey);
    return traced(
      NextResponse.json(
        {
          organizationId: data.organizationId,
          displayName: data.displayName,
          orgType: data.orgType,
          description: data.description,
          bookingTypes: data.bookingTypes,
          branding: data.branding,
          stats: data.stats,
          platformConnected: typeof data.apiKey === "string",
        },
        { status: 201 },
      ),
      response,
    );
  } catch {
    return failure(
      503,
      "Onboarding did not return a response. Check My businesses before retrying to avoid creating a duplicate.",
    );
  }
}
