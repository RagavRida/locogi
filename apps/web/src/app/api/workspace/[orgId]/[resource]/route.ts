import { NextRequest, NextResponse } from "next/server";
import { websiteToken } from "@/lib/auth0";
import { ACCESS_COOKIE, failure, traced, upstream } from "@/lib/server";
import type { Membership } from "@/lib/contracts";
import { GET as businessRead } from "../../../business/[orgId]/[...path]/route";

export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  { params }: { params: { orgId: string; resource: string } },
) {
  if (params.resource === "bookings" && !process.env.API_VENDOR_BOOKINGS_PATH)
    return businessRead(request, {
      params: { orgId: params.orgId, path: ["bookings"] },
    });
  const token = await websiteToken(request);
  if (!token) return failure(401, "Please sign in.");
  if (!["bookings", "analytics", "messages"].includes(params.resource))
    return failure(404, "Not found.");
  try {
    const result = await upstream("/organizations/mine", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!result.ok)
      return traced(
        failure(result.status, "Cannot verify your business membership."),
        result,
      );
    const memberships = (await result.json()) as {
      organizations: Membership[];
    };
    const member = memberships.organizations.find(
      (entry) => entry.id === params.orgId,
    );
    if (!member) return failure(403, "Business membership required.");
    if (
      ["analytics", "messages"].includes(params.resource) &&
      !["owner", "manager"].includes(member.role)
    )
      return failure(403, "Your role cannot view business earnings.");
    const path =
      params.resource === "bookings"
        ? process.env.API_VENDOR_BOOKINGS_PATH
        : params.resource === "messages"
          ? process.env.API_VENDOR_MESSAGES_PATH
          : process.env.API_VENDOR_ANALYTICS_PATH;
    if (!path)
      return failure(
        501,
        params.resource === "bookings"
          ? "This API does not expose a verified JWT-authorized organization booking list. Customer bookings are not substituted. Connect an org-scoped endpoint to enable this view."
          : params.resource === "messages"
            ? "An authorized organization message-list endpoint has not been configured. No customer conversations are fabricated."
            : "Revenue trends and conversion analytics are not available from this API. /ops/digest is a platform operations feed, not organization analytics.",
      );
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("..") ||
      path.includes("?")
    )
      return failure(500, "Invalid server endpoint configuration.");
    const query = new URLSearchParams(request.nextUrl.searchParams);
    query.set("orgId", member.id);
    const source = await upstream(`${path}?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!source.ok)
      return traced(
        failure(
          source.status,
          "The business data endpoint could not complete this request.",
        ),
        source,
      );
    return traced(NextResponse.json(await source.json()), source);
  } catch {
    return failure();
  }
}
