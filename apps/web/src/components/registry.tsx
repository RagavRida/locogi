"use client";

import { useEffect, useState, type ComponentType } from "react";
import type { UIComponentType } from "@locogi/types";
import {
  catalogSections,
  money,
  type Booking,
  type CatalogResponse,
  type ChatReply,
  type ChatSchema,
  type CommerceComponent,
  type ContextResponse,
  type Resource,
} from "@/lib/contracts";
import { useData, useSession, useTopic } from "./providers";
import { Availability } from "./business";
import { BookingCard, TrackingView } from "./bookings";
import { BusinessCard } from "./services";
import { Empty, LoadState, Notice } from "./ui";

export interface CardProps {
  data: Record<string, unknown>;
  orgId?: string;
  active: boolean;
  busy: boolean;
  send: (message: string) => Promise<ChatReply | undefined>;
  select: (bookingId: string, forIntent?: string) => Promise<void>;
}
function id(data: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys)
    if (
      typeof data[key] === "string" &&
      /^[a-zA-Z0-9_-]+$/.test(data[key] as string)
    )
      return data[key] as string;
  return undefined;
}
function Missing({ subject }: { subject: string }) {
  return (
    <Notice>
      The agent did not supply a {subject} identifier. No saved prices or
      statuses are displayed.
    </Notice>
  );
}
function LiveBooking(props: CardProps) {
  const bookingId = id(props.data, "bookingId", "requestId");
  return bookingId ? (
    <BookingCard bookingId={bookingId} onSend={props.send} />
  ) : (
    <Missing subject="booking" />
  );
}
function TrackingCard(props: CardProps) {
  const bookingId = id(props.data, "bookingId", "requestId");
  return bookingId ? (
    <TrackingView bookingId={bookingId} />
  ) : (
    <Missing subject="booking" />
  );
}
function BookingListCard(props: CardProps) {
  const bookings = useData<{ bookings: Booking[] }>("/bookings?all=true");
  const ids = Array.isArray(props.data.bookingIds)
    ? props.data.bookingIds.filter(
        (value): value is string => typeof value === "string",
      )
    : null;
  const list =
    bookings.data?.bookings.filter(
      (booking) => ids === null || ids.includes(booking.id),
    ) || [];
  return (
    <div>
      <LoadState {...bookings} retry={bookings.refresh} />
      {list.map((booking) => (
        <BookingCard
          key={booking.id}
          bookingId={booking.id}
          onSend={props.send}
        />
      ))}
      {!bookings.loading && !bookings.error && !list.length && (
        <Empty title="No bookings found." icon="calendar" />
      )}
    </div>
  );
}
function SelectorCard(props: CardProps) {
  const bookings = useData<{ bookings: Booking[] }>("/bookings?all=true");
  const ids = Array.isArray(props.data.bookingIds)
    ? props.data.bookingIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const list =
    bookings.data?.bookings.filter((booking) => ids.includes(booking.id)) || [];
  return (
    <div>
      <h3>Which booking did you mean?</h3>
      <LoadState {...bookings} retry={bookings.refresh} />
      {list.map((booking) => (
        <button
          className="selection-option"
          key={booking.id}
          disabled={props.busy || !props.active}
          onClick={() =>
            void props.select(
              booking.id,
              typeof props.data.forIntent === "string"
                ? props.data.forIntent
                : undefined,
            )
          }
        >
          <strong>{booking.title || "Booking"}</strong>
          <span>{booking.status.replaceAll("_", " ")}</span>
        </button>
      ))}
      {!bookings.loading && !bookings.error && !list.length && (
        <p className="muted">No matching bookings are available.</p>
      )}
    </div>
  );
}
function ConfirmationCard(props: CardProps) {
  const bookingId = id(props.data, "bookingId", "requestId");
  const context = useData<ContextResponse>("/chat/context");
  const pending = context.data?.context?.pendingConfirmation;
  const permitted =
    props.active &&
    !props.busy &&
    !context.loading &&
    !context.error &&
    !!bookingId &&
    pending?.bookingId === bookingId;
  return (
    <div className="confirmation-card">
      <span className="mini-label">EXPLICIT CONFIRMATION REQUIRED</span>
      <h3>You’re in control.</h3>
      <p>
        Nothing is changed by this card. Confirm only if you want the agent to
        perform the pending action.
      </p>
      {bookingId ? (
        <BookingCard bookingId={bookingId} compact />
      ) : (
        <Missing subject="booking" />
      )}
      <LoadState {...context} retry={context.refresh} />
      <div className="button-row">
        <button
          className="button primary"
          disabled={!permitted}
          onClick={() => void props.send("no")}
        >
          Keep booking
        </button>
        <button
          className="button danger"
          disabled={!permitted}
          onClick={() => void props.send("yes")}
        >
          Yes, confirm action
        </button>
      </div>
      {!context.loading && !context.error && !permitted && (
        <p className="muted">
          This is a historical card or no matching confirmation is pending.
        </p>
      )}
      <small>
        The server checks expiry, ownership, and single-use confirmation.
      </small>
    </div>
  );
}
function CatalogCard(props: CardProps) {
  const orgId = id(props.data, "orgId", "organizationId") || props.orgId;
  const catalog = useData<CatalogResponse>(
    orgId ? `/widget/catalog/${encodeURIComponent(orgId)}` : null,
  );
  if (!orgId) return <Missing subject="business" />;
  return (
    <div>
      <LoadState {...catalog} retry={catalog.refresh} />
      {catalogSections(catalog.data).map((section) => (
        <div key={section.name}>
          <h3>{section.name}</h3>
          {section.items.map((item) => (
            <div className="inline-catalog-item" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <p>{item.description}</p>
                <span>{money(item.price, item.currency)}</span>
              </div>
              <button
                className="button secondary small"
                disabled={props.busy || !props.active}
                onClick={() =>
                  void props.send(
                    `Add one ${item.name} to my cart (catalog item ${item.id}).`,
                  )
                }
              >
                Add +
              </button>
            </div>
          ))}
        </div>
      ))}
      {!catalog.loading &&
        !catalog.error &&
        !catalogSections(catalog.data).length && (
          <Empty title="No catalog items available." />
        )}
    </div>
  );
}
function VendorCard(props: CardProps) {
  const explicitIds = Array.isArray(props.data.orgIds)
    ? props.data.orgIds.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const nestedIds = Array.isArray(props.data.items)
    ? props.data.items.flatMap((value) =>
        value && typeof value === "object"
          ? [
              id(
                value as Record<string, unknown>,
                "orgId",
                "organizationId",
                "id",
              ),
            ].filter((value): value is string => !!value)
          : [],
      )
    : [];
  const ids = [...new Set([...explicitIds, ...nestedIds])];
  return ids.length ? (
    <div className="inline-businesses">
      {ids.map((orgId) => (
        <div key={orgId}>
          <BusinessCard orgId={orgId} />
          <WebReferences data={props.data} orgId={orgId} />
        </div>
      ))}
    </div>
  ) : (
    <Missing subject="business" />
  );
}
function WebReferences({
  data,
  orgId,
}: {
  data: Record<string, unknown>;
  orgId: string;
}) {
  const item = Array.isArray(data.items)
    ? data.items.find(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          (entry.id === orgId || entry.orgId === orgId),
      )
    : null;
  const references = Array.isArray(item?.portfolio)
    ? item.portfolio
        .flatMap((entry: unknown) => {
          if (
            !entry ||
            typeof entry !== "object" ||
            !("url" in entry) ||
            typeof entry.url !== "string"
          )
            return [];
          try {
            const url = new URL(entry.url);
            if (url.protocol !== "https:" || url.username || url.password)
              return [];
            return [
              {
                url: url.href,
                title:
                  "title" in entry && typeof entry.title === "string"
                    ? entry.title
                    : url.hostname,
              },
            ];
          } catch {
            return [];
          }
        })
        .slice(0, 3)
    : [];
  return references.length ? (
    <aside className="web-references">
      <span className="integration-badge">Web sources · Exa</span>
      <p>
        Links cited in this message. Web discovery is not an independent
        verification of the business.
      </p>
      {references.map((reference: { url: string; title: string }) => (
        <a
          key={reference.url}
          href={reference.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {reference.title} ↗
        </a>
      ))}
    </aside>
  ) : null;
}
function ResourceCard(props: CardProps) {
  const orgId = id(props.data, "orgId", "organizationId") || props.orgId;
  const resources = useData<{ resources: Resource[] }>(
    orgId ? `/widget/resources/${encodeURIComponent(orgId)}` : null,
  );
  if (!orgId) return <Missing subject="business" />;
  return (
    <div>
      <h3>Choose your person.</h3>
      <LoadState {...resources} retry={resources.refresh} />
      {resources.data?.resources.map((resource) => (
        <button
          className="selection-option"
          key={resource.id}
          disabled={props.busy || !props.active}
          onClick={() =>
            void props.send(
              `Choose ${resource.name} (resource ${resource.id}).`,
            )
          }
        >
          <strong>{resource.name}</strong>
          <span>{resource.specialization}</span>
        </button>
      ))}
      {!resources.loading &&
        !resources.error &&
        !resources.data?.resources.length && (
          <p className="muted">No resources are available.</p>
        )}
    </div>
  );
}
function SlotCard(props: CardProps) {
  const resourceId = id(props.data, "resourceId");
  return resourceId ? (
    <Availability
      resourceId={resourceId}
      onSelect={
        props.busy || !props.active
          ? undefined
          : (slot) => {
              void props.send(`Choose slot ${slot.id} at ${slot.time}.`);
            }
      }
    />
  ) : (
    <>
      <Missing subject="resource" />
      <ResourceCard {...props} />
    </>
  );
}
function QuotesCard(props: CardProps) {
  const requestId = id(props.data, "requestId", "bookingId");
  useTopic("booking", requestId);
  const quotes = useData<{
    quotes: {
      responseId: string;
      vendorName: string;
      quotedPrice: number;
      message?: string;
    }[];
  }>(requestId ? `/requests/${encodeURIComponent(requestId)}/quotes` : null);
  if (!requestId) return <Missing subject="request" />;
  return (
    <div>
      <h3>Live quotes</h3>
      <LoadState {...quotes} retry={quotes.refresh} />
      {quotes.data?.quotes.map((quote) => (
        <div className="inline-catalog-item" key={quote.responseId}>
          <div>
            <strong>{quote.vendorName}</strong>
            <p>{quote.message}</p>
            <span>{money(quote.quotedPrice)}</span>
          </div>
          <button
            className="button secondary small"
            disabled={props.busy || !props.active}
            onClick={() =>
              void props.send(
                `I would like to accept quote ${quote.responseId} for request ${requestId}. Please confirm the details.`,
              )
            }
          >
            Choose quote
          </button>
        </div>
      ))}
      {!quotes.loading && !quotes.error && !quotes.data?.quotes.length && (
        <p className="muted">No quotes received yet.</p>
      )}
    </div>
  );
}
function CartCard(props: CardProps) {
  const context = useData<ContextResponse>(
    `/chat/context${props.orgId ? `?orgId=${encodeURIComponent(props.orgId)}` : ""}`,
  );
  return (
    <div>
      <h3>Your cart</h3>
      <LoadState {...context} retry={context.refresh} />
      {context.data?.session?.cart ? (
        <div>
          {context.data.session.cart.map((item, index) => (
            <div className="analytic-row" key={item.id || index}>
              <span>
                {item.name} × {item.quantity ?? item.qty ?? "Not reported"}
              </span>
              <strong>{money(item.price)}</strong>
            </div>
          ))}
          {context.data.session.total != null && (
            <div className="analytic-row">
              <strong>Server total</strong>
              <strong>{money(context.data.session.total)}</strong>
            </div>
          )}
        </div>
      ) : (
        context.data && (
          <Notice>
            This API has no authorized cart read endpoint. Cart quantities and
            totals are not rendered from saved UI snapshots. Continue with the
            agent’s text response.
          </Notice>
        )
      )}
    </div>
  );
}
function OfferCard(props: CardProps) {
  const context = useData<ContextResponse>(
    `/chat/context${props.orgId ? `?orgId=${encodeURIComponent(props.orgId)}` : ""}`,
  );
  const offer = context.data?.session?.offer;
  return (
    <div>
      <h3>Offer details</h3>
      <LoadState {...context} retry={context.refresh} />
      {offer ? (
        <>
          <p>{offer.code}</p>
          <p>Discount: {money(offer.discount)}</p>
          <strong>Updated total: {money(offer.newTotal)}</strong>
        </>
      ) : (
        context.data && (
          <Notice>
            No current offer was returned by the context API. Saved discounts
            and totals are not treated as live prices.
          </Notice>
        )
      )}
    </div>
  );
}
function PhoneCard(props: CardProps) {
  const { user } = useSession();
  const [phone, setPhone] = useState(user?.phone || "");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void props.send(phone);
      }}
    >
      <label>
        Booking contact number
        <input
          type="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          pattern="\+?[0-9]{10,15}"
          required
          disabled={props.busy || !props.active}
        />
      </label>
      <button className="button primary" disabled={props.busy || !props.active}>
        Use this number
      </button>
    </form>
  );
}
function CommerceConfirmation(props: CardProps) {
  return (
    <div>
      <h3>Review before confirming.</h3>
      <CartCard {...props} />
      <Notice>
        Confirm only after reviewing the agent’s booking details. The backend
        checks price and availability before creating the booking.
      </Notice>
      <div className="button-row">
        <button
          className="button primary"
          disabled={props.busy || !props.active}
          onClick={() => void props.send("Yes, confirm my booking.")}
        >
          Confirm booking
        </button>
        <button
          className="button secondary"
          disabled={props.busy || !props.active}
          onClick={() => void props.send("No, I want to change the details.")}
        >
          Change details
        </button>
      </div>
    </div>
  );
}
function BookingWithAutomation(props: CardProps) {
  return (
    <div>
      <LiveBooking {...props} />
      <div className="automation-note">
        <span className="integration-badge">
          Trigger.dev · booking automations
        </span>
        <p>
          Confirmation, vendor notification, payment follow-up, and review
          request are backend jobs. Their delivery status is not exposed by this
          API; no completed-job checkmarks are inferred from booking
          confirmation.
        </p>
      </div>
    </div>
  );
}
function ContextCard(props: CardProps) {
  const context = useData<ContextResponse>("/chat/context");
  const bookingId =
    id(props.data, "bookingId", "requestId") ||
    context.data?.context?.activeBookingId;
  return (
    <div>
      <LoadState {...context} retry={context.refresh} />
      {bookingId ? (
        <BookingCard bookingId={bookingId} onSend={props.send} />
      ) : (
        context.data && (
          <p className="muted">
            Continue the conversation above. No active booking data is available
            for this card.
          </p>
        )
      )}
    </div>
  );
}
function RebookCard(props: CardProps) {
  const bookingId = id(props.data, "bookingId", "requestId");
  return (
    <div>
      <LiveBooking {...props} />
      <button
        className="button secondary"
        disabled={!bookingId || props.busy || !props.active}
        onClick={() =>
          void props.send(
            `I'd like to rebook ${bookingId}. Please show current availability.`,
          )
        }
      >
        Ask to book again
      </button>
    </div>
  );
}
export const REGISTRY: Record<
  UIComponentType | CommerceComponent,
  ComponentType<CardProps>
> = {
  confirmation: ContextCard,
  category: CatalogCard,
  vendor_list: VendorCard,
  quote: QuotesCard,
  quote_list: QuotesCard,
  slot_picker: SlotCard,
  job_tracker: TrackingCard,
  review: LiveBooking,
  rebook: RebookCard,
  follow_up: ContextCard,
  ambiguity: SelectorCard,
  searching: ContextCard,
  booking_list: BookingListCard,
  booking_detail: LiveBooking,
  booking_status: LiveBooking,
  booking_selector: SelectorCard,
  booking_tracking: TrackingCard,
  confirm_action: ConfirmationCard,
  empty_state: BookingListCard,
  payment: LiveBooking,
  catalog_grid: CatalogCard,
  cart_summary: CartCard,
  resource_picker: ResourceCard,
  booking_confirmation: BookingWithAutomation,
  order_status: TrackingCard,
  offer_applied: OfferCard,
  phone_prompt: PhoneCard,
  confirmation_prompt: CommerceConfirmation,
  error: ContextCard,
};
export function ServerCard({
  schema,
  ...props
}: Omit<CardProps, "data"> & { schema: ChatSchema }) {
  const { setUiType } = useSession();
  const known = Object.prototype.hasOwnProperty.call(REGISTRY, schema.type);
  useEffect(() => {
    if (known) setUiType(schema.type);
  }, [known, schema.type, setUiType]);
  if (!known) return null;
  const Component = REGISTRY[schema.type];
  return (
    <div className="server-card">
      <div className="card-provenance">
        <span className="dot live" />
        {schema.type.replaceAll("_", " ")}
        <span>Fetched live</span>
      </div>
      <Component
        {...props}
        data={schema.data && typeof schema.data === "object" ? schema.data : {}}
      />
    </div>
  );
}
