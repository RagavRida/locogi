import { NextRequest, NextResponse } from "next/server";
import { checkOrigin, failure, traced, upstream } from "@/lib/server";
import {
  forgetPlatformKey,
  membership,
  platformKey,
  rememberPlatformKey,
} from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
async function handler(
  request: NextRequest,
  { params }: { params: { orgId: string; path: string[] } },
) {
  if (request.method !== "GET" && !checkOrigin(request))
    return failure(403, "Cross-origin request refused.");
  const path = params.path.join("/");
  if (
    !/^(connection|catalog|bookings(?:\/[\w-]+)?|resources|availability|keys(?:\/[\w-]+)?|webhooks(?:\/[\w-]+)?)$/.test(
      path,
    )
  )
    return failure(404, "Operation unavailable.");
  try {
    const access = await membership(request, params.orgId);
    if (!access)
      return failure(403, "An active membership in this business is required.");
    const { member, token } = access;
    const owner = member.role === "owner";
    const manager = owner || member.role === "manager";
    if (
      ["staff", "practitioner"].includes(member.role) &&
      path.startsWith("bookings")
    )
      return failure(
        request.method === "GET" ? 501 : 403,
        "Only assigned bookings may be shown to this role. The API does not expose an assigned-booking read here; organization-wide bookings are not substituted.",
      );
    if (
      ((path === "connection" && request.method !== "GET") ||
        path.startsWith("keys") ||
        path.startsWith("webhooks")) &&
      !owner
    )
      return failure(403, "Only the business owner can manage integrations.");
    if (["catalog", "resources", "availability"].includes(path) && !manager)
      return failure(
        403,
        "This operation is restricted to owners and managers.",
      );
    const jwt = { Authorization: `Bearer ${token}` };
    if (
      path === "catalog" &&
      request.method !== "GET" &&
      member.can_manage_catalog === false
    )
      return failure(
        403,
        "Catalog management is disabled for this membership.",
      );
    if (path === "connection") {
      if (
        request.method === "GET" &&
        request.nextUrl.searchParams.get("download") === "1"
      ) {
        if (!owner || request.headers.get("sec-fetch-site") !== "same-origin")
          return failure(
            403,
            "Use the owner’s Settings page to download this credential.",
          );
        const key = platformKey(params.orgId);
        if (!key) return failure(404, "No key is held for this business.");
        return new NextResponse(
          JSON.stringify({ organizationId: params.orgId, apiKey: key }),
          {
            headers: {
              "Content-Type": "application/json",
              "Content-Disposition":
                'attachment; filename="locogi-integration.json"',
              "Cache-Control": "no-store",
            },
          },
        );
      }
      if (request.method === "GET")
        return NextResponse.json(
          { connected: !!platformKey(params.orgId) },
          { headers: { "Cache-Control": "no-store" } },
        );
      if (request.method !== "POST") return failure(405, "Method not allowed.");
      const response = await upstream("/platform/api-keys", {
        method: "POST",
        headers: jwt,
        body: JSON.stringify({
          organizationId: params.orgId,
          label: "Locogi web workspace",
          environment: "live",
        }),
      });
      if (!response.ok)
        return traced(
          failure(response.status, "The API could not connect this workspace."),
          response,
        );
      const data = await response.json();
      const key = data.key ?? data.apiKey;
      if (typeof key !== "string")
        return failure(
          502,
          "The API did not return an integration credential.",
        );
      rememberPlatformKey(params.orgId, key);
      return traced(NextResponse.json({ connected: true }), response);
    }
    if (path.startsWith("keys")) {
      const list = await upstream(
        `/platform/api-keys?organizationId=${encodeURIComponent(params.orgId)}`,
        { headers: jwt },
      );
      if (!list.ok)
        return traced(
          failure(list.status, "Could not read key metadata."),
          list,
        );
      const data = await list.json();
      if (request.method === "GET" && path === "keys")
        return traced(
          NextResponse.json({
            keys: (data.keys || []).map((key: Record<string, unknown>) => ({
              id: key.id,
              label: key.label ?? key.name,
              prefix: key.key_prefix ?? key.prefix,
              active: key.is_active,
              createdAt: key.created_at ?? key.createdAt,
            })),
          }),
          list,
        );
      const keyId = params.path[1];
      if (request.method !== "DELETE" || !keyId)
        return failure(405, "Method not allowed.");
      if (!data.keys?.some((key: { id: string }) => key.id === keyId))
        return failure(404, "Key not found in this business.");
      const response = await upstream(
        `/platform/api-keys/${encodeURIComponent(keyId)}`,
        { method: "DELETE", headers: jwt },
      );
      if (!response.ok)
        return traced(
          failure(response.status, "Could not revoke this key."),
          response,
        );
      forgetPlatformKey(params.orgId);
      return traced(NextResponse.json({ success: true }), response);
    }
    const key = platformKey(params.orgId);
    if (!key)
      return failure(
        428,
        "This business needs a server-side platform connection. Ask the owner to connect it in Settings, or onboard a new business.",
      );
    const headers = { ...jwt, "x-api-key": key, "x-org-id": params.orgId };
    const method = request.method;
    if (path.startsWith("bookings/")) {
      const bookingId = params.path[1];
      let owned = false;
      for (let offset = 0; offset < 1000 && !owned; offset += 100) {
        const listing = await upstream(
          `/platform/bookings?limit=100&offset=${offset}`,
          { headers },
        );
        if (!listing.ok)
          return traced(
            failure(listing.status, "Could not verify booking access."),
            listing,
          );
        const batch = await listing.json();
        owned =
          batch.bookings?.some(
            (booking: { id: string }) => booking.id === bookingId,
          ) === true;
        if (!Array.isArray(batch.bookings) || batch.bookings.length < 100)
          break;
      }
      if (!owned)
        return failure(
          404,
          "This booking was not returned by the organization’s authorized booking list.",
        );
      if (method !== "GET" && method !== "PATCH")
        return failure(405, "Method not allowed.");
      let body: string | undefined;
      if (method === "PATCH") {
        const input = await request.json();
        if (!["confirmed", "cancelled", "completed"].includes(input.status))
          return failure(400, "Unsupported requested status.");
        if (member.can_accept_bookings === false || !owner)
          return failure(403, "Your role cannot perform this action.");
        body = JSON.stringify({ status: input.status });
      }
      const response = await upstream(`/platform/${path}`, {
        method,
        headers,
        body,
      });
      if (!response.ok)
        return traced(
          failure(
            response.status,
            "The API did not allow this booking action. Refresh to see its current state.",
          ),
          response,
        );
      return traced(NextResponse.json(await response.json()), response);
    }
    if (path === "availability") {
      const resourceId = request.nextUrl.searchParams.get("resourceId");
      const listing = await upstream("/platform/resources", { headers });
      if (!listing.ok)
        return traced(
          failure(listing.status, "Could not verify resource access."),
          listing,
        );
      const resources = await listing.json();
      if (
        !resourceId ||
        !resources.resources?.some(
          (resource: { id: string }) => resource.id === resourceId,
        )
      )
        return failure(404, "Resource not found in this business.");
    }
    if (
      method !== "GET" &&
      !(path === "catalog" && method === "POST") &&
      !(path === "webhooks" && method === "POST") &&
      !(path.startsWith("webhooks/") && method === "DELETE")
    )
      return failure(405, "This operation is not exposed by the verified API.");
    let body: string | undefined;
    if (method === "POST") {
      const input = await request.json();
      if (path === "catalog") {
        const items = Array.isArray(input.items) ? input.items : [input];
        body = JSON.stringify({
          items: items.map((item: Record<string, unknown>) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            price: item.price,
            section: item.section,
            isAvailable: item.isAvailable,
            isVeg: item.isVeg,
          })),
        });
      } else
        body = JSON.stringify({
          url: input.url,
          events: input.events,
          description: input.description,
        });
    }
    const response = await upstream(
      `/platform/${path}${request.nextUrl.search}`,
      { method, headers, body },
    );
    if (!response.ok)
      return traced(
        failure(
          response.status,
          "The platform API rejected this operation. No changes were simulated.",
        ),
        response,
      );
    const data = await response.json();
    if (path === "catalog" && method === "GET") {
      const sections: Record<string, unknown[]> = Object.create(null);
      for (const item of data.items || []) {
        const section = item.section || "General";
        (sections[section] ??= []).push({
          id: item.id,
          name: item.name,
          description: item.description,
          price: item.price ?? item.base_price,
          currency: item.currency,
          section,
          imageUrl: item.imageUrl ?? item.image_url,
          isAvailable: item.isAvailable ?? item.is_available,
        });
      }
      return traced(NextResponse.json({ sections }), response);
    }
    if (path === "resources" && method === "GET")
      return traced(
        NextResponse.json({
          resources: (data.resources || []).map(
            (resource: Record<string, unknown>) => ({
              id: resource.id,
              name: resource.name,
              specialization: resource.specialization,
              qualification: resource.qualification,
              resource_type: resource.type ?? resource.resource_type,
              price_per_slot:
                resource.price ??
                resource.price_per_slot ??
                resource.base_price,
            }),
          ),
        }),
        response,
      );
    if (path === "webhooks") {
      const clean = (hook: Record<string, unknown>) => ({
        id: hook.id,
        url: hook.url,
        events: hook.events,
        active: hook.is_active ?? hook.isActive,
      });
      return traced(
        NextResponse.json(
          method === "GET"
            ? { webhooks: (data.webhooks || []).map(clean) }
            : {
                webhook: data.webhook ? clean(data.webhook) : undefined,
                success: true,
              },
        ),
        response,
      );
    }
    return traced(NextResponse.json(data), response);
  } catch {
    return failure();
  }
}
export { handler as GET, handler as POST, handler as DELETE, handler as PATCH };
