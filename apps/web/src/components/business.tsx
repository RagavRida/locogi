"use client";

import Link from "next/link";
import { useState } from "react";
import { post, invalidate } from "@/lib/client";
import {
  catalogSections,
  money,
  safeImage,
  when,
  type Business,
  type CatalogResponse,
  type Resource,
  type Slot,
} from "@/lib/contracts";
import { useData } from "./providers";
import { Empty, Icon, LoadState, Notice, PageShell } from "./ui";

export function Availability({
  resourceId,
  onSelect,
}: {
  resourceId: string;
  onSelect?: (slot: Slot) => void;
}) {
  const [date, setDate] = useState(new Date().toLocaleDateString("en-CA"));
  const slots = useData<{ dates: Record<string, Slot[]> }>(
    `/widget/availability/${encodeURIComponent(resourceId)}?date=${date}&days=1`,
  );
  const options = Object.values(slots.data?.dates || {}).flat();
  return (
    <div className="availability">
      <label>
        Choose a date
        <input
          type="date"
          required
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </label>
      <LoadState {...slots} retry={slots.refresh} />
      <div className="slot-grid">
        {options.map((slot) => (
          <button
            className="slot-button"
            key={slot.id}
            onClick={() => onSelect?.(slot)}
            disabled={!onSelect}
          >
            {new Date(slot.time).toLocaleTimeString("en-IN", {
              hour: "numeric",
              minute: "2-digit",
            })}
            <span>
              {slot.available} available
              {slot.price != null ? ` · ${money(slot.price)}` : ""}
            </span>
          </button>
        ))}
      </div>
      {!slots.loading && !slots.error && !options.length && (
        <p className="muted">No available slots for this date.</p>
      )}
    </div>
  );
}
function DirectBooking({
  business,
  resource,
  onClose,
}: {
  business: Business;
  resource: Resource;
  onClose: () => void;
}) {
  const [slot, setSlot] = useState<Slot | null>(null);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    bookingId?: string;
    requestId?: string;
    message?: string;
  } | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!slot || busy || result) return;
    setBusy(true);
    setError("");
    try {
      setResult(
        await post("/widget/book", {
          orgId: business.orgId,
          resourceId: resource.id,
          slotId: slot.id,
          bookingType: "appointment",
          customerPhone: phone,
          customerName: name,
        }),
      );
      invalidate();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not submit.");
      setSlot(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel booking-form-panel"
      aria-label="Review appointment"
    >
      <div className="panel-heading">
        <h3>Review your appointment</h3>
        <button className="text-button" onClick={onClose} disabled={busy}>
          Close
        </button>
      </div>
      {result ? (
        <div role="status">
          <Icon name="check" size={30} />
          <h3>API response received</h3>
          <p>
            {result.message ||
              "Your request was submitted. Check My Bookings for its current status."}
          </p>
          <Link className="button primary" href="/bookings">
            View my bookings
          </Link>
        </div>
      ) : (
        <form onSubmit={submit}>
          <p>
            {business.name} · {resource.name}
          </p>
          <Availability resourceId={resource.id} onSelect={setSlot} />
          {slot && (
            <Notice>
              Selected: {when(slot.time)}.{" "}
              {slot.price != null
                ? `Slot price: ${money(slot.price)}.`
                : "A final price has not been supplied."}{" "}
              The server verifies availability when you confirm.
            </Notice>
          )}
          <label>
            Your name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              autoComplete="name"
            />
          </label>
          <label>
            Phone number
            <input
              type="tel"
              value={phone}
              onChange={(event) =>
                setPhone(event.target.value.replace(/\s/g, ""))
              }
              required
              pattern="\+?[0-9]{10,14}"
              autoComplete="tel"
              placeholder="+919876543210"
            />
          </label>
          <label className="checkbox-label">
            <input type="checkbox" required />I have reviewed this appointment
            and want to submit it.
          </label>
          {error && (
            <div className="error-box" role="alert">
              {error} Check your bookings before retrying if the response was
              interrupted.
            </div>
          )}
          <button className="button primary full" disabled={!slot || busy}>
            {busy ? "Submitting…" : "Confirm appointment"}
            <Icon name="arrow" />
          </button>
        </form>
      )}
    </section>
  );
}
export default function BusinessProfile({ orgId }: { orgId: string }) {
  const business = useData<Business>(
    `/widget/config/${encodeURIComponent(orgId)}`,
  );
  const catalog = useData<CatalogResponse>(
    `/widget/catalog/${encodeURIComponent(orgId)}`,
  );
  const resources = useData<{ resources: Resource[] }>(
    `/widget/resources/${encodeURIComponent(orgId)}`,
  );
  const [resource, setResource] = useState<Resource | null>(null);
  const info = business.data;
  const cover = safeImage(info?.branding?.coverUrl);
  return (
    <PageShell>
      <div id="content" className="page-container profile-page">
        <Link className="back-link" href="/services">
          ← Explore services
        </Link>
        <LoadState {...business} retry={business.refresh} />
        {info && (
          <>
            <div className="profile-cover">
              {cover ? (
                <img src={cover} alt={info.name} />
              ) : (
                <div className="profile-cover-art">
                  <span>
                    LOCAL EXPERTISE.
                    <br />
                    PERSONAL TOUCH.
                  </span>
                  <span>✳</span>
                </div>
              )}
            </div>
            <div className="profile-header">
              <div>
                <p className="eyebrow">{info.type?.replaceAll("_", " ")}</p>
                <h1>{info.name}</h1>
                <p className="location">
                  <Icon name="pin" size={16} />
                  {info.address || info.area || "Address not supplied"}
                </p>
              </div>
              <Link
                className="button primary"
                href={`/chat?orgId=${encodeURIComponent(orgId)}`}
              >
                Chat with Agent <Icon name="chat" />
              </Link>
            </div>
            <div className="profile-columns">
              <div>
                <section className="profile-section">
                  <h2>Find your perfect fit.</h2>
                  <p className="muted">
                    Explore the catalog. Ask the agent about the details.
                  </p>
                  <LoadState {...catalog} retry={catalog.refresh} />
                  {catalogSections(catalog.data).map((section) => (
                    <div key={section.name} className="catalog-section">
                      <h3>{section.name}</h3>
                      {section.items.map((item) => (
                        <article className="catalog-row" key={item.id}>
                          <div>
                            <h4>{item.name}</h4>
                            {item.description && <p>{item.description}</p>}
                            <span className="catalog-price">
                              {money(item.price, item.currency)}
                            </span>
                          </div>
                          <Link
                            className="icon-button"
                            aria-label={`Ask about ${item.name}`}
                            href={`/chat?orgId=${encodeURIComponent(orgId)}&prompt=${encodeURIComponent(`Tell me about ${item.name} (catalog item ${item.id})`)}`}
                          >
                            <Icon name="plus" />
                          </Link>
                        </article>
                      ))}
                    </div>
                  ))}
                  {!catalog.loading &&
                    !catalog.error &&
                    !catalogSections(catalog.data).length && (
                      <Empty title="The catalog is empty.">
                        <p>Ask the business agent about its services.</p>
                      </Empty>
                    )}
                </section>
                <section className="profile-section">
                  <h2>Meet the people.</h2>
                  <LoadState {...resources} retry={resources.refresh} />
                  <div className="resource-grid">
                    {resources.data?.resources.map((person) => (
                      <article className="resource-card" key={person.id}>
                        <span className="resource-avatar">
                          {person.name.slice(0, 1)}
                        </span>
                        <h3>{person.name}</h3>
                        <p>{person.specialization || person.resource_type}</p>
                        {person.qualification && (
                          <span>{person.qualification}</span>
                        )}
                        {person.price_per_slot != null && (
                          <strong>{money(person.price_per_slot)}</strong>
                        )}
                        {info.bookingTypes?.includes("appointment") ? (
                          <button
                            className="button secondary small"
                            onClick={() => setResource(person)}
                          >
                            See availability
                          </button>
                        ) : (
                          <Link
                            className="button secondary small"
                            href={`/chat?orgId=${encodeURIComponent(orgId)}&prompt=${encodeURIComponent(`I'd like to book ${person.name} (resource ${person.id})`)}`}
                          >
                            Ask the agent
                          </Link>
                        )}
                      </article>
                    ))}
                  </div>
                  {!resources.loading &&
                    !resources.error &&
                    !resources.data?.resources.length && (
                      <Empty
                        title="No staff or resources listed."
                        icon="users"
                      />
                    )}
                </section>
                <section className="profile-section">
                  <h2>Local voices.</h2>
                  {info.reviews?.length ? (
                    info.reviews.map((review) => (
                      <article className="review-card" key={review.id}>
                        <strong>
                          {review.author} · {review.rating} / 5
                        </strong>
                        <p>{review.text}</p>
                      </article>
                    ))
                  ) : (
                    <p className="muted">
                      No reviews were supplied by the business API.
                    </p>
                  )}
                </section>
              </div>
              <aside className="profile-sidebar">
                {resource ? (
                  <DirectBooking
                    business={info}
                    resource={resource}
                    onClose={() => setResource(null)}
                  />
                ) : (
                  <div className="panel">
                    <span className="eyebrow">LET’S TALK DETAILS</span>
                    <h3>A little help goes a long way.</h3>
                    <p>
                      Packages, availability, special requests. The business’s
                      agent is the place to ask.
                    </p>
                    <Link
                      className="button primary full"
                      href={`/chat?orgId=${encodeURIComponent(orgId)}`}
                    >
                      Start a conversation <Icon name="arrow" />
                    </Link>
                    <hr />
                    <dl className="info-list">
                      <dt>Contact</dt>
                      <dd>{info.phone || "Not supplied"}</dd>
                      <dt>Hours</dt>
                      <dd>{info.hours || "Ask the agent"}</dd>
                      <dt>Location</dt>
                      <dd>{info.area || "Not supplied"}</dd>
                    </dl>
                  </div>
                )}
              </aside>
            </div>
          </>
        )}
      </div>
    </PageShell>
  );
}
