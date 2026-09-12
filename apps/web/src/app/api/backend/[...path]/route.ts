import { NextRequest, NextResponse } from "next/server";
import { websiteToken } from "@/lib/auth0";
import {
  ACCESS_COOKIE,
  checkOrigin,
  failure,
  traced,
  upstream,
} from "@/lib/server";

export const dynamic = "force-dynamic";
const routes = [
  { pattern: /^search\/catalog$/, methods: ["GET"], public: true },
  {
    pattern: /^widget\/(config|catalog|resources|availability)\/[\w-]+$/,
    methods: ["GET"],
    public: true,
  },
  { pattern: /^widget\/book$/, methods: ["POST"], public: true },
  { pattern: /^categories\/search$/, methods: ["GET"] },
  { pattern: /^users\/me$/, methods: ["GET", "PATCH"] },
  { pattern: /^chat$/, methods: ["POST"] },
  { pattern: /^chat\/(history|context)$/, methods: ["GET"] },
  { pattern: /^chat\/select$/, methods: ["POST"] },
  { pattern: /^bookings(\/[\w-]+(\/tracking)?)?$/, methods: ["GET"] },
  { pattern: /^requests\/[\w-]+\/quotes$/, methods: ["GET"] },
  { pattern: /^vendors\/(stats|inbox)$/, methods: ["GET"] },
  { pattern: /^organizations\/mine$/, methods: ["GET"] },
  {
    pattern: /^organizations\/[\w-]+\/(catalog|resources|status)$/,
    methods: ["GET"],
  },
  {
    pattern: /^organizations\/[\w-]+\/(catalog|practitioners|invites|slots)$/,
    methods: ["POST"],
  },
];
async function handler(
  request: NextRequest,
  { params }: { params: { path: string[] } },
) {
  const path = params.path.join("/");
  const rule = routes.find(
    (candidate) =>
      candidate.pattern.test(path) &&
      candidate.methods.includes(request.method),
  );
  if (!rule)
    return failure(404, "This operation is not available in this web console.");
  if (request.method !== "GET" && !checkOrigin(request))
    return failure(403, "Cross-origin request refused.");
  const token = await websiteToken(request);
  if (!rule.public && !token)
    return failure(401, "Please sign in to continue.");
  try {
    let body: string | undefined;
    if (request.method !== "GET") {
      const input = await request.json();
      if (path === "chat") {
        if (typeof input.message !== "string" || input.message.length > 2000)
          return failure(400, "Enter a message of up to 2,000 characters.");
        body = JSON.stringify({
          [process.env.API_CHAT_FIELD || "text"]: input.message,
          ...(input.orgId ? { orgId: input.orgId } : {}),
          ...(process.env.API_CHAT_FIELD === "message" &&
          typeof input.sessionId === "string"
            ? { sessionId: input.sessionId }
            : {}),
        });
      } else body = JSON.stringify(input);
    }
    if (path.startsWith("organizations/") && path !== "organizations/mine") {
      const memberships = await upstream("/organizations/mine", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!memberships.ok)
        return traced(
          failure(memberships.status, "Could not verify business access."),
          memberships,
        );
      const data = await memberships.json();
      const member = data.organizations?.find(
        (entry: { id: string }) => entry.id === params.path[1],
      );
      if (!member)
        return failure(403, "You are not a member of this business.");
      if (request.method !== "GET") {
        const staffAction = ["practitioners", "invites"].includes(
          params.path[2],
        );
        const allowed = staffAction
          ? member.role === "owner"
          : ["owner", "manager"].includes(member.role);
        if (!allowed) return failure(403, "Your role cannot make this change.");
      }
    }
    const upstreamPath =
      path === "categories/search"
        ? process.env.API_CATEGORY_SEARCH_PATH || "/search/categories"
        : `/${path}`;
    const source = await upstream(`${upstreamPath}${request.nextUrl.search}`, {
      method: request.method,
      body,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!source.ok) {
      const labels: Record<number, string> = {
        400: "The API rejected these details. Check the required fields.",
        401: "Your session expired. Please sign in again.",
        403: "Your account does not have access to this operation.",
        404: "This resource or API operation is not available.",
        409: "This action is no longer available. Refresh and try again.",
        429: "Too many requests. Please wait before trying again.",
      };
      return traced(
        failure(
          source.status,
          labels[source.status] || "The API could not complete this request.",
        ),
        source,
      );
    }
    if (source.status === 204)
      return traced(new NextResponse(null, { status: 204 }), source);
    const responseData = await source.json();
    if (
      path === "organizations/mine" &&
      Array.isArray(responseData.organizations)
    )
      return traced(
        NextResponse.json({
          organizations: responseData.organizations.map(
            (org: Record<string, unknown>) => ({
              ...org,
              display_name: org.display_name ?? org.displayName,
              org_type: org.org_type ?? org.orgType,
              role: org.role ?? org.memberRole,
            }),
          ),
        }),
        source,
      );
    if (path.startsWith("widget/config/") && responseData.organization) {
      const org = responseData.organization;
      return traced(
        NextResponse.json({
          orgId: org.id ?? params.path[2],
          name: org.displayName,
          type: org.orgType,
          area: org.area,
          address: org.address,
          phone: org.contactPhone,
          hours: org.hours,
          rating: org.rating,
          reviews: org.reviews,
          portfolio: org.portfolio,
          bookingTypes: org.supportedBookingTypes,
          branding: { logoUrl: org.logoUrl, coverUrl: org.coverUrl },
        }),
        source,
      );
    }
    if (
      path.startsWith("widget/catalog/") &&
      Array.isArray(responseData.items)
    ) {
      const sections: Record<string, unknown[]> = Object.create(null);
      for (const item of responseData.items)
        (sections[item.section || "General"] ??= []).push(item);
      return traced(NextResponse.json({ sections }), source);
    }
    if (path === "search/catalog" && Array.isArray(responseData.items))
      return traced(
        NextResponse.json({
          results: responseData.items.map((item: Record<string, unknown>) => ({
            id: item.id,
            content: item.name,
            metadata: {
              name: item.name,
              organization_id: item.orgId,
              base_price: item.price,
            },
          })),
        }),
        source,
      );
    if (path === "categories/search" && Array.isArray(responseData.categories))
      return traced(
        NextResponse.json({ suggestions: responseData.categories }),
        source,
      );
    if (path === "categories/search" && Array.isArray(responseData.results)) {
      return traced(
        NextResponse.json({
          suggestions: responseData.results
            .map(
              (entry: {
                id?: string;
                content?: string;
                metadata?: { canonical_name?: string };
              }) => ({
                id: entry.id,
                name: entry.metadata?.canonical_name || entry.content || "",
              }),
            )
            .filter((entry: { name: string }) => entry.name),
        }),
        source,
      );
    }
    return traced(NextResponse.json(responseData), source);
  } catch {
    return failure();
  }
}
export { handler as GET, handler as POST, handler as PATCH };
