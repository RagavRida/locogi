"use client";
import { useMemo, useState } from "react";
import { useCopilotAction, useCopilotReadable } from "@copilotkit/react-core";
import { api, invalidate, post } from "@/lib/client";
import {
  catalogSections,
  money,
  type Booking,
  type CatalogResponse,
  type Membership,
} from "@/lib/contracts";
import { vendorPermissions } from "@/lib/vendor-permissions";

function Approval({
  title,
  details,
  execute,
  respond,
}: {
  title: string;
  details: string;
  execute: () => Promise<unknown>;
  respond?: (result: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);
  return (
    <section className="panel">
      <h3>{title}</h3>
      <p>{details}</p>
      <p>
        Confirm before changing the live business. The API rechecks your
        permission.
      </p>
      <div className="button-row">
        <button
          className="button primary small"
          disabled={!respond || busy || answered}
          onClick={async () => {
            if (!respond || busy || answered) return;
            setBusy(true);
            try {
              await execute();
              invalidate();
              setAnswered(true);
              respond({
                success: true,
                message:
                  "The API accepted the change. Refetch for current data.",
              });
            } catch (error) {
              setAnswered(true);
              respond({
                success: false,
                message:
                  error instanceof Error
                    ? error.message
                    : "The API rejected this operation.",
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Confirm change"}
        </button>
        <button
          className="button secondary small"
          disabled={!respond || busy || answered}
          onClick={() => {
            setAnswered(true);
            respond?.({ success: false, cancelled: true });
          }}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
export function useCatalogCopilot(
  member: Membership,
  catalog?: CatalogResponse,
) {
  const permissions = vendorPermissions(member);
  const items = useMemo(
    () => catalogSections(catalog).flatMap((section) => section.items),
    [catalog],
  );
  useCopilotReadable(
    {
      description:
        "Current authorized catalog from the platform API. Prices are API-provided; do not invent packages or availability.",
      value: permissions.editCatalog
        ? items
        : { available: false, reason: "Catalog access is restricted by role." },
    },
    [items, permissions.editCatalog],
  );
  useCopilotAction(
    {
      name: "addCatalogItem",
      description:
        "Propose a new catalog service. Requires the vendor’s confirmation before the API is called. Duration is not supported by this API; do not claim it is saved.",
      available: permissions.editCatalog ? "enabled" : "disabled",
      parameters: [
        { name: "name", type: "string", required: true },
        { name: "price", type: "number", required: true },
        { name: "section", type: "string", required: false },
        { name: "description", type: "string", required: false },
      ],
      renderAndWaitForResponse: ({ args, respond }) => (
        <Approval
          title="Add catalog service"
          details={`${args.name || "New service"} · ${money(args.price)}`}
          respond={respond}
          execute={() =>
            post(`/api/business/${member.id}/catalog`, {
              items: [
                {
                  name: args.name,
                  price: args.price,
                  section: args.section,
                  description: args.description,
                },
              ],
            })
          }
        />
      ),
    },
    [member.id, permissions.editCatalog],
  );
  useCopilotAction(
    {
      name: "updateItemPrice",
      description:
        "Propose changing the price of an existing catalog item, identified by its exact API ID. Requires confirmation.",
      available: permissions.editCatalog ? "enabled" : "disabled",
      parameters: [
        { name: "itemId", type: "string", required: true },
        { name: "price", type: "number", required: true },
      ],
      renderAndWaitForResponse: ({ args, respond }) => (
        <Approval
          title="Update service price"
          details={`Item ${args.itemId || "not selected"} → ${money(args.price)}`}
          respond={respond}
          execute={async () => {
            const latest = await api<CatalogResponse>(
              `/api/business/${member.id}/catalog`,
            );
            const item = catalogSections(latest)
              .flatMap((section) => section.items)
              .find((item) => item.id === args.itemId);
            if (!item)
              throw new Error(
                "That catalog item is not available to this business.",
              );
            return post(`/api/business/${member.id}/catalog`, {
              items: [{ ...item, price: args.price }],
            });
          }}
        />
      ),
    },
    [member.id, permissions.editCatalog],
  );
  useCopilotAction(
    {
      name: "setCatalogAvailability",
      description:
        "Propose enabling or pausing a catalog item. Requires confirmation.",
      available: permissions.editCatalog ? "enabled" : "disabled",
      parameters: [
        { name: "itemId", type: "string", required: true },
        { name: "available", type: "boolean", required: true },
      ],
      renderAndWaitForResponse: ({ args, respond }) => (
        <Approval
          title="Change service availability"
          details={`Item ${args.itemId || "not selected"}: ${args.available ? "available" : "paused"}`}
          respond={respond}
          execute={async () => {
            const latest = await api<CatalogResponse>(
              `/api/business/${member.id}/catalog`,
            );
            const item = catalogSections(latest)
              .flatMap((section) => section.items)
              .find((item) => item.id === args.itemId);
            if (!item) throw new Error("Catalog item not found.");
            return post(`/api/business/${member.id}/catalog`, {
              items: [{ ...item, isAvailable: args.available }],
            });
          }}
        />
      ),
    },
    [member.id, permissions.editCatalog],
  );
}
export function useBookingsCopilot(member: Membership, bookings?: Booking[]) {
  const permissions = vendorPermissions(member);
  const today = new Date().toDateString();
  useCopilotReadable(
    {
      description:
        "Today's bookings from the currently loaded authorized API page. Missing slot times are not assumed to mean today. This is not an exhaustive organization history.",
      value: permissions.assignedOnly
        ? {
            available: false,
            reason:
              "Only assigned bookings may be read; the backend must supply that scope.",
          }
        : (bookings || [])
            .filter(
              (booking) =>
                booking.slotTime &&
                new Date(booking.slotTime).toDateString() === today,
            )
            .map((booking) => ({
              id: booking.id,
              title: booking.title || booking.description,
              status: booking.status,
              slotTime: booking.slotTime,
            })),
    },
    [bookings, permissions.assignedOnly, today],
  );
  useCopilotAction(
    {
      name: "updateBookingStatus",
      description:
        "Propose a booking status change by exact booking ID. Owner only; the owner must confirm, and the API decides if the transition is valid.",
      available: permissions.updateBookings ? "enabled" : "disabled",
      parameters: [
        { name: "bookingId", type: "string", required: true },
        {
          name: "status",
          type: "string",
          enum: ["confirmed", "cancelled", "completed"],
          required: true,
        },
      ],
      renderAndWaitForResponse: ({ args, respond }) => (
        <Approval
          title="Update live booking"
          details={`Booking ${args.bookingId || "not selected"} → ${args.status || "not selected"}`}
          respond={respond}
          execute={() =>
            api(
              `/api/business/${member.id}/bookings/${encodeURIComponent(args.bookingId || "")}`,
              {
                method: "PATCH",
                body: JSON.stringify({ status: args.status }),
              },
            )
          }
        />
      ),
    },
    [member.id, permissions.updateBookings],
  );
}
export function useAnalyticsCopilot(
  member: Membership,
  data: unknown,
  source: string,
) {
  const permissions = vendorPermissions(member);
  useCopilotReadable(
    {
      description: `Verified analytics context. Source/scope: ${source}. Never turn lifetime totals into today's or this week's sales.`,
      value: permissions.viewRevenue
        ? { source, data: data ?? null }
        : {
            available: false,
            reason:
              "Organization earnings are restricted to owners and managers.",
          },
    },
    [data, source, permissions.viewRevenue],
  );
  useCopilotAction(
    {
      name: "getBusinessAnalytics",
      description:
        "Read authorized organization analytics for a requested period. Return the API's unavailable message honestly if this metric is not exposed.",
      available: permissions.viewRevenue ? "enabled" : "disabled",
      parameters: [
        {
          name: "period",
          type: "string",
          enum: ["daily", "weekly", "monthly"],
          required: true,
        },
      ],
      handler: async ({ period }) => {
        try {
          return await api(
            `/api/workspace/${member.id}/analytics?period=${encodeURIComponent(period)}`,
          );
        } catch (error) {
          return {
            available: false,
            message:
              error instanceof Error ? error.message : "Analytics unavailable.",
          };
        }
      },
    },
    [member.id, permissions.viewRevenue],
  );
}
export function useMessagesCopilot(
  member: Membership,
  messages: unknown,
  setDraft: (text: string) => void,
) {
  const allowed = member.role === "owner" || member.role === "manager";
  useCopilotReadable(
    {
      description:
        "Authorized customer messages. If messages are unavailable, do not invent conversations or summaries.",
      value: allowed
        ? (messages ?? { available: false })
        : { available: false, reason: "No access to organization messages." },
    },
    [messages, allowed],
  );
  useCopilotAction(
    {
      name: "draftCustomerReply",
      description:
        "Draft text for the vendor to review. Does not send a message or change a booking.",
      available: allowed ? "enabled" : "disabled",
      parameters: [{ name: "draft", type: "string", required: true }],
      handler: ({ draft }) => {
        setDraft(draft);
        return { drafted: true, sent: false };
      },
    },
    [allowed, setDraft],
  );
}
