"use client";

import Link from "next/link";
import { useState } from "react";
import { money, when, type Booking, type Tracking } from "@/lib/contracts";
import { useData, useTopic } from "./providers";
import {
  Empty,
  Icon,
  LoadState,
  Notice,
  PageShell,
  RequireAuth,
  Status,
} from "./ui";

export function TrackingView({ bookingId }: { bookingId: string }) {
  useTopic("tracking", bookingId);
  const tracking = useData<Tracking>(
    `/bookings/${encodeURIComponent(bookingId)}/tracking`,
  );
  const data = tracking.data;
  return (
    <div className="tracking-view">
      <h3>
        <Icon name="pin" size={18} /> Live tracking
      </h3>
      <LoadState {...tracking} retry={tracking.refresh} />
      {data && (
        <>
          {data.vendorName && <p>{data.vendorName}</p>}
          {!data.available && (
            <Notice>
              {data.why?.replaceAll("_", " ") ||
                "Tracking is currently unavailable."}
            </Notice>
          )}
          {data.etaMinutes != null && (
            <p>
              Estimated arrival: <strong>{data.etaMinutes} minutes</strong>
            </p>
          )}
          {data.distanceKm != null && (
            <p>
              Straight-line distance: <strong>{data.distanceKm} km</strong>
            </p>
          )}
          {data.events?.length ? (
            <ol className="timeline">
              {data.events.map((event, index) => (
                <li key={`${event.timestamp}-${index}`}>
                  <strong>{event.phase.replaceAll("_", " ")}</strong>
                  <span>{when(event.timestamp)}</span>
                </li>
              ))}
            </ol>
          ) : data.phase ? (
            <ol className="timeline">
              <li>
                <strong>{data.phase.replaceAll("_", " ")}</strong>
              </li>
            </ol>
          ) : (
            <p className="muted">
              The tracking endpoint does not supply a phase timeline. No
              progress is inferred from location or socket messages.
            </p>
          )}
        </>
      )}
    </div>
  );
}
export function BookingCard({
  bookingId,
  onSend,
  compact = false,
}: {
  bookingId: string;
  onSend?: (message: string) => Promise<unknown>;
  compact?: boolean;
}) {
  useTopic("booking", bookingId);
  const booking = useData<Booking>(
    `/bookings/${encodeURIComponent(bookingId)}`,
  );
  const [tracking, setTracking] = useState(false);
  const data = booking.data;
  return (
    <article className="booking-card">
      <LoadState {...booking} retry={booking.refresh} />
      {data && (
        <>
          <div className="booking-card-heading">
            <span className="booking-icon">
              <Icon name="calendar" />
            </span>
            <div>
              <span className="mini-label">CURRENT BOOKING · REST</span>
              <h3>{data.title || data.description || "Booking"}</h3>
            </div>
            <Status value={data.status} />
          </div>
          <div className="booking-facts">
            <div>
              <span>Provider</span>
              <strong>{data.vendorName || "Not assigned"}</strong>
            </div>
            <div>
              <span>Scheduled</span>
              <strong>{when(data.slotTime)}</strong>
            </div>
            <div>
              <span>Agreed price</span>
              <strong>{money(data.price ?? data.agreedPrice)}</strong>
            </div>
          </div>
          {!compact && (
            <div className="button-row">
              {data.canTrack && (
                <button
                  className="button secondary small"
                  onClick={() => setTracking((value) => !value)}
                >
                  <Icon name="pin" size={16} />
                  {tracking ? "Hide tracking" : "Track booking"}
                </button>
              )}
              {data.canCancel &&
                (onSend ? (
                  <button
                    className="button danger small"
                    onClick={() => void onSend(`Cancel booking ${data.id}`)}
                  >
                    Request cancellation
                  </button>
                ) : (
                  <Link
                    className="button danger small"
                    href={`/chat?prompt=${encodeURIComponent(`Cancel booking ${data.id}`)}`}
                  >
                    Request cancellation
                  </Link>
                ))}
            </div>
          )}
          {tracking && <TrackingView bookingId={bookingId} />}
        </>
      )}
    </article>
  );
}
function BookingList() {
  const bookings = useData<{ bookings: Booking[] }>("/bookings?all=true");
  const [filter, setFilter] = useState("all");
  const entries =
    bookings.data?.bookings.filter(
      (booking) => filter === "all" || booking.status === filter,
    ) || [];
  const statuses = [
    ...new Set(bookings.data?.bookings.map((booking) => booking.status)),
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">ALL YOUR PLANS, IN ONE PLACE</p>
          <h1>Good things on the calendar.</h1>
          <p className="muted">
            Current information, straight from the business.
          </p>
        </div>
        <Link className="button primary" href="/services">
          Find something new <Icon name="plus" size={18} />
        </Link>
      </div>
      <div className="filter-row">
        <button
          className={filter === "all" ? "selected" : ""}
          onClick={() => setFilter("all")}
        >
          All bookings
        </button>
        {statuses.map((status) => (
          <button
            className={filter === status ? "selected" : ""}
            key={status}
            onClick={() => setFilter(status)}
          >
            {status.replaceAll("_", " ")}
          </button>
        ))}
        <button onClick={bookings.refresh}>Refresh</button>
      </div>
      <LoadState {...bookings} retry={bookings.refresh} />
      {!bookings.loading && !bookings.error && !entries.length && (
        <Empty title="Nothing booked here yet." icon="calendar">
          <p>Your next great local experience is a conversation away.</p>
          <Link className="button primary" href="/chat">
            Start a conversation
          </Link>
        </Empty>
      )}
      <div className="bookings-list">
        {entries.map((booking) => (
          <BookingCard key={booking.id} bookingId={booking.id} />
        ))}
      </div>
      <Notice>
        Cancellations open a conversation. The agent asks for explicit
        confirmation before executing the change.
      </Notice>
    </>
  );
}
export default function Bookings() {
  return (
    <PageShell>
      <div className="page-container" id="content">
        <RequireAuth>
          <BookingList />
        </RequireAuth>
      </div>
    </PageShell>
  );
}
