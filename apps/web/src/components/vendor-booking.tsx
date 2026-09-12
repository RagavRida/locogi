"use client";
import { useState } from "react";
import { api, invalidate } from "@/lib/client";
import { money, when, type Booking, type Membership } from "@/lib/contracts";
import { useData } from "./providers";
import { LoadState, Notice, Status } from "./ui";

export default function VendorBooking({
  org,
  bookingId,
  close,
}: {
  org: Membership;
  bookingId: string;
  close: () => void;
}) {
  const booking = useData<
    Booking & { customerPhone?: string; resourceName?: string }
  >(`/api/business/${org.id}/bookings/${encodeURIComponent(bookingId)}`);
  const [action, setAction] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    if (!action || busy) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/api/business/${org.id}/bookings/${encodeURIComponent(bookingId)}`,
        { method: "PATCH", body: JSON.stringify({ status: action }) },
      );
      setAction(null);
      invalidate();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "The action did not complete.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="booking-detail-panel">
      <div className="panel-heading">
        <h3>Booking details</h3>
        <button className="text-button" onClick={close} disabled={busy}>
          Close
        </button>
      </div>
      <LoadState {...booking} retry={booking.refresh} />
      {booking.data && (
        <>
          <h3>{booking.data.title || booking.data.description || "Booking"}</h3>
          <p>
            {booking.data.customerName || "Customer not supplied"}
            {booking.data.customerPhone
              ? ` · ${booking.data.customerPhone}`
              : ""}
          </p>
          <Status value={booking.data.status} />
          <p>
            {when(booking.data.slotTime)} ·{" "}
            {money(booking.data.price ?? booking.data.agreedPrice)}
          </p>
          {booking.data.resourceName && <p>{booking.data.resourceName}</p>}
          {org.role === "owner" && (
            <div className="button-row">
              <button
                className="button primary small"
                disabled={busy}
                onClick={() => setAction("confirmed")}
              >
                Accept booking
              </button>
              {["owner", "manager"].includes(org.role) && (
                <>
                  <button
                    className="button danger small"
                    disabled={busy}
                    onClick={() => setAction("cancelled")}
                  >
                    Reject / cancel
                  </button>
                  <button
                    className="button secondary small"
                    disabled={busy}
                    onClick={() => setAction("completed")}
                  >
                    Mark completed
                  </button>
                </>
              )}
            </div>
          )}
          {action && (
            <div role="alert">
              <Notice>
                Request status “{action}” for this booking? The backend decides
                whether the transition is allowed. This action affects a real
                booking.
              </Notice>
              <div className="button-row">
                <button
                  className="button danger"
                  disabled={busy}
                  onClick={() => void confirm()}
                >
                  {busy ? "Requesting…" : "Confirm action"}
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => setAction(null)}
                >
                  Keep current state
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
