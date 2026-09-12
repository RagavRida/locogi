"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { invalidate, post } from "@/lib/client";
import {
  catalogSections,
  money,
  when,
  type Booking,
  type Business,
  type CatalogResponse,
  type CatalogItem,
  type Membership,
  type Resource,
  type Stats,
} from "@/lib/contracts";
import { useData, useSession } from "./providers";
import { Availability } from "./business";
import { IntegrationSettings, ProfileSettings } from "./vendor-settings";
import VendorBooking from "./vendor-booking";
import {
  useAnalyticsCopilot,
  useBookingsCopilot,
  useCatalogCopilot,
  useMessagesCopilot,
} from "./copilot-actions";
import { useCopilotReadable } from "@copilotkit/react-core";
import {
  Brand,
  Empty,
  Icon,
  LoadState,
  Notice,
  RequireAuth,
  Status,
} from "./ui";

const WorkspaceContext = createContext<Membership | null>(null);
const VendorCopilot = dynamic(() => import("./copilot"), { ssr: false });
function pageAllowed(role: Membership["role"], path: string) {
  if (role === "owner") return true;
  if (role === "manager")
    return !["/dashboard/resources", "/dashboard/settings"].includes(path);
  return path === "/dashboard/bookings";
}
function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("No workspace");
  return context;
}
const navigation = [
  { href: "/dashboard", label: "Overview", icon: "grid" },
  { href: "/dashboard/catalog", label: "Catalog", icon: "food" },
  { href: "/dashboard/bookings", label: "Bookings", icon: "calendar" },
  { href: "/dashboard/messages", label: "Messages", icon: "chat" },
  { href: "/dashboard/resources", label: "People & resources", icon: "users" },
  { href: "/dashboard/schedule", label: "Schedule", icon: "calendar" },
  { href: "/dashboard/analytics", label: "Analytics", icon: "chart" },
  { href: "/dashboard/settings", label: "Settings", icon: "settings" },
];
function WorkspaceFrame({ children }: { children: React.ReactNode }) {
  const memberships = useData<{ organizations: Membership[] }>(
    "/organizations/mine",
  );
  const [selected, setSelected] = useState("");
  const pathname = usePathname();
  const router = useRouter();
  const { user, wsState } = useSession();
  const organizations = memberships.data?.organizations || [];
  const organization =
    organizations.find((member) => member.id === selected) || organizations[0];
  const title =
    navigation.find((item) => item.href === pathname)?.label || "Overview";
  useEffect(() => {
    if (
      organization &&
      pathname === "/dashboard" &&
      ["staff", "practitioner"].includes(organization.role)
    )
      router.replace("/dashboard/bookings");
  }, [organization?.role, pathname, router]);
  useEffect(() => {
    const orgId = new URLSearchParams(window.location.search).get("orgId");
    if (orgId) setSelected(orgId);
  }, []);
  if ((!memberships.data && memberships.loading) || memberships.error)
    return (
      <div className="page-container" id="content">
        <Brand />
        <LoadState {...memberships} retry={memberships.refresh} />
      </div>
    );
  if (!organization)
    return (
      <div className="page-container" id="content">
        <Brand />
        <Empty title="Your business workspace is waiting." icon="users">
          <p>
            Describe your business once. The backend creates your catalog,
            resources, and time slots. Already part of a team? Ask the owner for
            an invitation.
          </p>
          <Link className="button primary" href="/onboard">
            Set up my business with AI <Icon name="arrow" />
          </Link>
          <Link className="button secondary" href="/chat">
            I’m looking for a service
          </Link>
        </Empty>
      </div>
    );
  return (
    <WorkspaceContext.Provider value={organization}>
      <VendorCopilot key={organization.id} member={organization}>
        <div className="dashboard-layout">
          <aside className="dashboard-sidebar">
            <Brand />
            <label className="workspace-switcher">
              YOUR WORKSPACE
              <select
                aria-label="Select business"
                value={organization.id}
                onChange={(event) => setSelected(event.target.value)}
              >
                {organizations.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.display_name}
                  </option>
                ))}
              </select>
              <span>{organization.role} access</span>
            </label>
            <nav aria-label="Business navigation">
              {navigation
                .filter((item) => pageAllowed(organization.role, item.href))
                .map((item) => (
                  <Link
                    href={item.href}
                    key={item.href}
                    className={pathname === item.href ? "active" : ""}
                  >
                    <Icon name={item.icon} size={19} />
                    {item.label}
                    {pathname === item.href && (
                      <span className="nav-active-dot" />
                    )}
                  </Link>
                ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="sidebar-tip">
                <span>✧</span>
                <strong>Your next pair of hands.</strong>
                <p>Chat with your business’s agent to explore its services.</p>
                <Link
                  className="inline-link"
                  href={`/chat?orgId=${organization.id}`}
                >
                  Open business agent ↗
                </Link>
              </div>
              <Link className="back-link" href="/">
                ← Customer experience
              </Link>
              <div className="account-chip">
                <span>{user?.name?.slice(0, 1) || "Y"}</span>
                <div>
                  <strong>{user?.name || "Your account"}</strong>
                  <small>{organization.role}</small>
                </div>
              </div>
            </div>
          </aside>
          <div className="dashboard-body">
            <header className="dashboard-header">
              <div>
                <span className="muted">Workspace</span>
                <span className="breadcrumb-slash">/</span>
                <strong>{title}</strong>
              </div>
              <div>
                <span className="live-label">
                  <span className={`dot ${wsState === "live" ? "live" : ""}`} />
                  {wsState === "live" ? "Live updates" : "Updates reconnecting"}
                </span>
                <span className="integration-badge">
                  ✧ CopilotKit · {organization.role}
                </span>
              </div>
            </header>
            <main
              id="content"
              className="dashboard-content"
              key={organization.id}
            >
              {pageAllowed(organization.role, pathname) ? (
                children
              ) : (
                <Empty
                  title="This page isn’t available to your role."
                  icon="shield"
                >
                  <Link className="button primary" href="/dashboard/bookings">
                    Go to bookings
                  </Link>
                </Empty>
              )}
            </main>
          </div>
        </div>
      </VendorCopilot>
    </WorkspaceContext.Provider>
  );
}
export function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <WorkspaceFrame>{children}</WorkspaceFrame>
    </RequireAuth>
  );
}
function Heading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {children}
    </div>
  );
}
function StatsGrid() {
  const member = useWorkspace();
  const stats = useData<Stats>("/vendors/stats");
  useAnalyticsCopilot(
    member,
    stats.data,
    "/vendors/stats: vendor-account totals, not a daily or weekly organization report",
  );
  return (
    <>
      <LoadState {...stats} retry={stats.refresh} />
      <div className="stats-grid">
        {[
          {
            label: "Completed jobs",
            value: stats.data?.completedJobs,
            icon: "check",
            caption: "Vendor account · lifetime",
          },
          {
            label: "Earnings",
            value:
              stats.data?.earnings != null
                ? money(stats.data.earnings)
                : undefined,
            icon: "chart",
            caption: "Vendor account · API total",
          },
          {
            label: "Quotes sent",
            value: stats.data?.quoted,
            icon: "chat",
            caption: "Vendor account · lifetime",
          },
          {
            label: "Acceptance rate",
            value:
              stats.data?.acceptanceRate != null
                ? `${stats.data.acceptanceRate}%`
                : undefined,
            icon: "calendar",
            caption: "Calculated by the server",
          },
        ].map((stat) => (
          <article className="stat-card" key={stat.label}>
            <div>
              <span>{stat.label}</span>
              <Icon name={stat.icon} size={18} />
            </div>
            <strong>{stat.value ?? "—"}</strong>
            <small>{stat.caption}</small>
          </article>
        ))}
      </div>
    </>
  );
}
function RecentBookings({ compact = false }: { compact?: boolean }) {
  const org = useWorkspace();
  const [status, setStatus] = useState("");
  const [customer, setCustomer] = useState("");
  const [from, setFrom] = useState("");
  const [until, setUntil] = useState("");
  const query = new URLSearchParams();
  if (status) query.set("status", status);
  if (customer) query.set("customer", customer);
  if (from) query.set("from", from);
  if (until) query.set("until", until);
  const result = useData<{ bookings: Booking[] }>(
    `/api/workspace/${org.id}/bookings?${query}`,
  );
  useBookingsCopilot(org, result.data?.bookings);
  const [detail, setDetail] = useState<Booking | null>(null);
  useEffect(() => {
    setDetail(null);
  }, [result.data]);
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{compact ? "Recent bookings" : "Your bookings"}</h2>
        {compact ? (
          <Link className="inline-link" href="/dashboard/bookings">
            View all ↗
          </Link>
        ) : (
          <button className="text-button" onClick={result.refresh}>
            Refresh
          </button>
        )}
      </div>
      {!compact && (
        <div className="table-filters">
          <label>
            Status
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              {[
                "pending",
                "confirmed",
                "in_progress",
                "completed",
                "cancelled",
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Customer
            <input
              value={customer}
              onChange={(event) => setCustomer(event.target.value)}
              placeholder="Search customer"
            />
          </label>
          <label>
            From
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
            />
          </label>
        </div>
      )}
      <LoadState {...result} retry={result.refresh} />
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Booking</th>
              <th>Customer</th>
              <th>When</th>
              <th>Amount</th>
              <th>Status</th>
              <th>
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {result.data?.bookings.map((booking) => (
              <tr key={booking.id}>
                <td>{booking.title || booking.description || booking.id}</td>
                <td>{booking.customerName || "Not supplied"}</td>
                <td>{when(booking.slotTime)}</td>
                <td>{money(booking.price ?? booking.agreedPrice)}</td>
                <td>
                  <Status value={booking.status} />
                </td>
                <td>
                  <button
                    className="text-button"
                    onClick={() => setDetail(booking)}
                  >
                    View ↗
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!result.loading && !result.error && !result.data?.bookings.length && (
        <Empty title="No bookings to show." icon="calendar" />
      )}
      {detail && (
        <VendorBooking
          org={org}
          bookingId={detail.id}
          close={() => setDetail(null)}
        />
      )}
    </section>
  );
}
export function DashboardHome() {
  const org = useWorkspace();
  const { user } = useSession();
  const inbox = useData<{
    requests: {
      id: string;
      rawDescription: string;
      createdAt: string;
      bookingType: string;
    }[];
  }>("/vendors/inbox");
  return (
    <>
      <Heading
        eyebrow="A LITTLE CLARITY FOR YOUR DAY"
        title={`Good to see you${user?.name ? `, ${user.name.split(" ")[0]}` : ""}.`}
      >
        <Link className="button primary" href={`/business/${org.id}`}>
          View your storefront <Icon name="arrow" size={17} />
        </Link>
      </Heading>
      <p className="dashboard-intro">
        Here’s what’s happening across your vendor account. Workspace:{" "}
        <strong>{org.display_name}</strong>.
      </p>
      {["owner", "manager"].includes(org.role) && <StatsGrid />}
      <div className="quick-actions">
        <Link href="/dashboard/catalog">
          <Icon name="plus" /> Add to your catalog{" "}
          <Icon name="arrow" size={16} />
        </Link>
        <Link href="/dashboard/schedule">
          <Icon name="calendar" /> Make time available{" "}
          <Icon name="arrow" size={16} />
        </Link>
        <Link href="/dashboard/resources">
          <Icon name="users" /> Your people <Icon name="arrow" size={16} />
        </Link>
      </div>
      <RecentBookings compact />
      <section className="panel activity-panel">
        <div className="panel-heading">
          <h2>Your vendor inbox</h2>
          <span className="muted">
            Live requests · not a fabricated activity feed
          </span>
        </div>
        <LoadState {...inbox} retry={inbox.refresh} />
        {inbox.data?.requests.map((request) => (
          <div className="activity-row" key={request.id}>
            <span className="activity-icon">
              <Icon name="chat" size={18} />
            </span>
            <div>
              <strong>{request.rawDescription}</strong>
              <p>
                {request.bookingType} · {when(request.createdAt)}
              </p>
            </div>
          </div>
        ))}
        {!inbox.loading && !inbox.error && !inbox.data?.requests.length && (
          <Empty title="Your inbox is clear." icon="chat" />
        )}
      </section>
    </>
  );
}
export function CatalogManagement() {
  const org = useWorkspace();
  const catalog = useData<CatalogResponse>(`/api/business/${org.id}/catalog`);
  useCatalogCopilot(org, catalog.data);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CatalogItem | null>(null);
  const [view, setView] = useState("grid");
  const [section, setSection] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const canManage = ["owner", "manager"].includes(org.role);
  const sections = catalogSections(catalog.data);
  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    const form = event.currentTarget;
    const values = new FormData(form);
    try {
      await post(`/api/business/${org.id}/catalog`, {
        items: [
          {
            ...(editing
              ? { id: editing.id, isAvailable: editing.isAvailable }
              : {}),
            name: values.get("name"),
            description: values.get("description"),
            section: values.get("section"),
            price: Number(values.get("price")),
          },
        ],
      });
      setSuccess("Catalog item saved by the API.");
      form.reset();
      setAdding(false);
      setEditing(null);
      invalidate();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading
        eyebrow="WHAT MAKES YOUR BUSINESS, YOURS"
        title="A catalog worth a conversation."
      >
        <button
          className="button primary"
          disabled={!canManage}
          onClick={() => {
            setEditing(null);
            setAdding((value) => !value);
          }}
        >
          <Icon name="plus" size={17} /> Add an item
        </button>
      </Heading>
      <Notice>
        Catalog changes go through your organization’s platform API. Deleting,
        image uploads, and persisted drag-to-reorder have no route in this
        checkout; pause an item to stop offering it.
      </Notice>
      {adding && (
        <form
          className="panel edit-form"
          key={editing?.id || "new"}
          onSubmit={add}
        >
          <h2>
            {editing ? "Update your offering." : "Something new to offer."}
          </h2>
          <div className="form-grid">
            <label>
              Name
              <input
                name="name"
                maxLength={120}
                required
                defaultValue={editing?.name}
              />
            </label>
            <label>
              Price (API units)
              <input
                name="price"
                type="number"
                min="0"
                step="0.01"
                required
                defaultValue={editing?.price ?? undefined}
              />
            </label>
            <label>
              Section
              <input
                name="section"
                maxLength={80}
                placeholder="e.g. Wedding"
                defaultValue={editing?.section}
              />
            </label>
            <label>
              Description
              <textarea
                name="description"
                maxLength={400}
                rows={2}
                defaultValue={editing?.description || ""}
              />
            </label>
          </div>
          <div className="button-row">
            <button className="button primary" disabled={busy}>
              {busy ? "Saving…" : "Save item"}
            </button>
            <button
              className="button secondary"
              type="button"
              onClick={() => setAdding(false)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {success && (
        <p className="success-text" role="status">
          {success}
        </p>
      )}
      <div className="catalog-toolbar">
        <div className="filter-row">
          <button
            className={section === "all" ? "selected" : ""}
            onClick={() => setSection("all")}
          >
            All items
          </button>
          {sections.map((entry) => (
            <button
              key={entry.name}
              className={section === entry.name ? "selected" : ""}
              onClick={() => setSection(entry.name)}
            >
              {entry.name}
            </button>
          ))}
        </div>
        <div className="segmented">
          <button
            aria-pressed={view === "grid"}
            onClick={() => setView("grid")}
          >
            Grid
          </button>
          <button
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            List
          </button>
        </div>
      </div>
      <LoadState {...catalog} retry={catalog.refresh} />
      <div className={`managed-catalog ${view}`}>
        {sections
          .filter((entry) => section === "all" || entry.name === section)
          .flatMap((entry) =>
            entry.items.map((item) => (
              <article className="managed-item" key={item.id}>
                <div className="managed-item-art">
                  <Icon name="grid" size={28} />
                </div>
                <div>
                  <span className="mini-label">{entry.name}</span>
                  <h3>{item.name}</h3>
                  <p>{item.description || "No description supplied."}</p>
                  <strong>{money(item.price, item.currency)}</strong>
                  <div className="button-row">
                    <button
                      className="button secondary small"
                      disabled={!canManage || busy}
                      onClick={() => {
                        setEditing(item);
                        setAdding(true);
                        window.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="button secondary small"
                      disabled={
                        !canManage || busy || item.isAvailable === undefined
                      }
                      onClick={async () => {
                        setBusy(true);
                        setError("");
                        try {
                          await post(`/api/business/${org.id}/catalog`, {
                            items: [
                              { ...item, isAvailable: !item.isAvailable },
                            ],
                          });
                          invalidate();
                        } catch (error) {
                          setError(
                            error instanceof Error
                              ? error.message
                              : "Could not update availability.",
                          );
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {item.isAvailable === false
                        ? "Make available"
                        : "Pause item"}
                    </button>
                  </div>
                </div>
              </article>
            )),
          )}
      </div>
      {!catalog.loading && !catalog.error && !sections.length && (
        <Empty title="Your catalog is a blank canvas.">
          <p>
            Add your first service to help your agent get to know your business.
          </p>
        </Empty>
      )}
    </>
  );
}
export function BookingsManagement() {
  return (
    <>
      <Heading
        eyebrow="EVERY APPOINTMENT. EVERY LITTLE DETAIL."
        title="Your plans, organized."
      />
      <RecentBookings />
    </>
  );
}
export function ResourcesManagement() {
  const org = useWorkspace();
  const resources = useData<{ resources: Resource[] }>(
    `/api/business/${org.id}/resources`,
  );
  const [selected, setSelected] = useState<Resource | null>(null);
  const [invite, setInvite] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    const data = new FormData(event.currentTarget);
    try {
      const result = await post<{ inviteCode: string }>(
        `/organizations/${org.id}/invites`,
        { phone: data.get("phone"), role: data.get("role") },
      );
      setMessage(
        `Invitation created. Share this invitation code privately with the invited member: ${result.inviteCode}`,
      );
      setInvite(false);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not invite.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading
        eyebrow="PEOPLE MAKE THE DIFFERENCE"
        title="Meet your dream team."
      >
        <button
          className="button primary"
          disabled={org.role !== "owner"}
          onClick={() => setInvite((value) => !value)}
        >
          <Icon name="plus" size={17} /> Invite a teammate
        </button>
      </Heading>
      <Notice>
        Inviting a teammate creates a membership invitation, not a bookable
        resource. General staff/resource creation is not exposed by this API;
        its practitioner endpoint is specific to clinicians.
      </Notice>
      {invite && (
        <form className="panel edit-form" onSubmit={submit}>
          <h2>A new face on the team.</h2>
          <div className="form-grid">
            <label>
              Phone number
              <input
                name="phone"
                type="tel"
                pattern="\+91[6-9][0-9]{9}"
                placeholder="+919876543210"
                required
              />
            </label>
            <label>
              Role
              <select name="role">
                <option value="staff">Staff</option>
                <option value="manager">Manager</option>
                <option value="practitioner">Practitioner</option>
              </select>
            </label>
          </div>
          <button className="button primary" disabled={busy}>
            {busy ? "Creating invitation…" : "Create invitation"}
          </button>
        </form>
      )}
      {message && (
        <div className="notice" role="status">
          {message}
        </div>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <LoadState {...resources} retry={resources.refresh} />
      <div className="resource-grid">
        {resources.data?.resources.map((resource) => (
          <article className="resource-card" key={resource.id}>
            <span className="resource-avatar">{resource.name.slice(0, 1)}</span>
            <h3>{resource.name}</h3>
            <p>{resource.specialization || resource.resource_type}</p>
            {resource.qualification && <span>{resource.qualification}</span>}
            <button
              className="button secondary small"
              onClick={() => setSelected(resource)}
            >
              View availability
            </button>
          </article>
        ))}
      </div>
      {!resources.loading &&
        !resources.error &&
        !resources.data?.resources.length && (
          <Empty title="No resources are listed yet." icon="users" />
        )}
      {selected && (
        <section className="panel">
          <div className="panel-heading">
            <h2>{selected.name}’s availability</h2>
            <button className="text-button" onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <Availability resourceId={selected.id} />
        </section>
      )}
    </>
  );
}
export function Schedule() {
  const org = useWorkspace();
  const resources = useData<{ resources: Resource[] }>(
    `/widget/resources/${org.id}`,
  );
  const bookings = useData<{ bookings: Booking[] }>(
    `/api/workspace/${org.id}/bookings`,
  );
  const [anchor, setAnchor] = useState(new Date());
  const [view, setView] = useState<"week" | "month">("week");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const days = Array.from(
    {
      length:
        view === "week"
          ? 7
          : new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate(),
    },
    (_, index) => {
      const date = new Date(anchor);
      date.setDate(
        view === "week"
          ? anchor.getDate() - anchor.getDay() + index
          : index + 1,
      );
      return date;
    },
  );
  async function generate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await post<{ created: number }>(
        `/organizations/${org.id}/slots`,
        {
          resourceId: form.get("resourceId"),
          daysOfWeek: form.getAll("days").map(Number),
          startTime: form.get("startTime"),
          endTime: form.get("endTime"),
          durationMinutes: Number(form.get("duration")),
          weeksAhead: Number(form.get("weeks")),
          capacityPerSlot: Number(form.get("capacity")),
        },
      );
      setMessage(`The API created ${response.created} slots.`);
      invalidate();
      setAdding(false);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not create slots.",
      );
    } finally {
      setBusy(false);
    }
  }
  function move(direction: number) {
    setAnchor((previous) => {
      const next = new Date(previous);
      if (view === "week") next.setDate(next.getDate() + direction * 7);
      else {
        next.setDate(1);
        next.setMonth(next.getMonth() + direction);
      }
      return next;
    });
  }
  return (
    <>
      <Heading
        eyebrow="MAKE ROOM FOR GOOD THINGS"
        title="Your time, beautifully arranged."
      >
        <button
          className="button primary"
          disabled={!["owner", "manager"].includes(org.role)}
          onClick={() => setAdding((value) => !value)}
        >
          Manage slots <Icon name="plus" size={17} />
        </button>
      </Heading>
      {adding && (
        <form className="panel edit-form" onSubmit={generate}>
          <h2>Open up your calendar.</h2>
          <LoadState {...resources} retry={resources.refresh} />
          <div className="form-grid">
            <label>
              Resource
              <select name="resourceId" required>
                <option value="">Choose a resource</option>
                {resources.data?.resources.map((resource) => (
                  <option key={resource.id} value={resource.id}>
                    {resource.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Start
              <input name="startTime" type="time" required />
            </label>
            <label>
              End
              <input name="endTime" type="time" required />
            </label>
            <label>
              Duration (minutes)
              <input
                name="duration"
                type="number"
                min="5"
                max="480"
                defaultValue="60"
                required
              />
            </label>
            <label>
              Weeks ahead
              <input
                name="weeks"
                type="number"
                min="1"
                max="12"
                defaultValue="1"
                required
              />
            </label>
            <label>
              Capacity per slot
              <input
                name="capacity"
                type="number"
                min="1"
                max="50"
                defaultValue="1"
                required
              />
            </label>
          </div>
          <fieldset>
            <legend>Days of the week</legend>
            <div className="day-options">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                (day, index) => (
                  <label key={day}>
                    <input type="checkbox" name="days" value={index} />
                    {day}
                  </label>
                ),
              )}
            </div>
          </fieldset>
          <button className="button primary" disabled={busy}>
            {busy ? "Creating…" : "Create availability"}
          </button>
        </form>
      )}
      {message && (
        <p className="success-text" role="status">
          {message}
        </p>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="calendar-toolbar">
        <div>
          <button
            className="icon-button"
            onClick={() => move(-1)}
            aria-label="Previous period"
          >
            ←
          </button>
          <h2>
            {anchor.toLocaleDateString("en-IN", {
              month: "long",
              year: "numeric",
            })}
          </h2>
          <button
            className="icon-button"
            onClick={() => move(1)}
            aria-label="Next period"
          >
            →
          </button>
        </div>
        <div className="segmented">
          <button
            aria-pressed={view === "week"}
            onClick={() => setView("week")}
          >
            Week
          </button>
          <button
            aria-pressed={view === "month"}
            onClick={() => setView("month")}
          >
            Month
          </button>
        </div>
      </div>
      <LoadState {...bookings} retry={bookings.refresh} />
      <div className={`calendar-grid ${view}`}>
        {days.map((date) => (
          <div className="calendar-cell" key={date.toISOString()}>
            <span>
              {date.toLocaleDateString("en-IN", { weekday: "short" })}
            </span>
            <strong>{date.getDate()}</strong>
            {bookings.data?.bookings
              .filter(
                (booking) =>
                  booking.slotTime &&
                  new Date(booking.slotTime).toDateString() ===
                    date.toDateString(),
              )
              .map((booking) => (
                <Link
                  className="calendar-booking"
                  key={booking.id}
                  href="/dashboard/bookings"
                >
                  <strong>
                    {booking.title || booking.description || "Booking"}
                  </strong>
                  <Status value={booking.status} />
                </Link>
              ))}
          </div>
        ))}
      </div>
      {bookings.error && (
        <p className="muted">
          Calendar structure only. Empty cells do not imply availability or an
          absence of bookings.
        </p>
      )}
    </>
  );
}
interface AnalyticsData {
  revenue?: { date: string; amount: number }[];
  topItems?: { name: string; revenue: number }[];
  funnel?: { label: string; count: number }[];
  conversionRate?: number;
}
export function Analytics() {
  const org = useWorkspace();
  const [period, setPeriod] = useState("daily");
  const allowed = ["owner", "manager"].includes(org.role);
  const data = useData<AnalyticsData>(
    allowed ? `/api/workspace/${org.id}/analytics?period=${period}` : null,
  );
  const values = data.data?.revenue || [];
  useCopilotReadable(
    {
      description:
        "Current organization analytics returned by the authorized API. An absent dataset means the metric is unavailable.",
      value: allowed
        ? (data.data ?? { available: false })
        : { access: "denied" },
    },
    [data.data, allowed],
  );
  const max = Math.max(1, ...values.map((point) => point.amount));
  if (!allowed)
    return (
      <Empty
        title="Earnings are restricted to owners and managers."
        icon="shield"
      />
    );
  return (
    <>
      <Heading
        eyebrow="A CLEARER PICTURE OF YOUR BUSINESS"
        title="See the bigger picture."
      >
        <div className="segmented">
          {["daily", "weekly", "monthly"].map((value) => (
            <button
              key={value}
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </Heading>
      <StatsGrid />
      <LoadState {...data} retry={data.refresh} />
      <section className="panel">
        <div className="panel-heading">
          <h2>Revenue over time</h2>
          <span className="muted">{period}</span>
        </div>
        {values.length ? (
          <div className="bar-chart" role="img" aria-label="Revenue by date">
            {values.map((point) => (
              <div className="bar-column" key={point.date}>
                <span>{money(point.amount)}</span>
                <div
                  className="chart-bar"
                  style={{ height: `${(point.amount / max) * 160}px` }}
                />
                <small>{point.date}</small>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No revenue series supplied." icon="chart">
            <p>No synthetic chart points or trend percentages are shown.</p>
          </Empty>
        )}
      </section>
      <div className="analytics-columns">
        <section className="panel">
          <h2>Top services</h2>
          {data.data?.topItems?.length ? (
            data.data.topItems.map((item) => (
              <div className="analytic-row" key={item.name}>
                <span>{item.name}</span>
                <strong>{money(item.revenue)}</strong>
              </div>
            ))
          ) : (
            <p className="muted">Item-level revenue is not available.</p>
          )}
        </section>
        <section className="panel">
          <h2>From discovery to booking</h2>
          {data.data?.funnel?.length ? (
            data.data.funnel.map((stage) => (
              <div className="analytic-row" key={stage.label}>
                <span>{stage.label}</span>
                <strong>{stage.count}</strong>
              </div>
            ))
          ) : (
            <p className="muted">
              Acquisition and conversion data are not supplied.
            </p>
          )}
          {data.data?.conversionRate != null && (
            <p>Conversion rate: {data.data.conversionRate}%</p>
          )}
        </section>
      </div>
    </>
  );
}
export function MessagesManagement() {
  const member = useWorkspace();
  const messages = useData<{
    messages: {
      id: string;
      customerName?: string;
      content: string;
      createdAt?: string;
    }[];
  }>(`/api/workspace/${member.id}/messages`);
  const [draft, setDraft] = useState("");
  useMessagesCopilot(member, messages.data, setDraft);
  return (
    <>
      <Heading
        eyebrow="CUSTOMER CONVERSATIONS"
        title="Your business, in conversation."
      />
      <LoadState {...messages} retry={messages.refresh} />
      <section className="panel">
        <h2>Customer messages</h2>
        {messages.data?.messages.map((message) => (
          <article className="activity-row" key={message.id}>
            <div>
              <strong>{message.customerName || "Customer"}</strong>
              <p>{message.content}</p>
              {message.createdAt && <small>{when(message.createdAt)}</small>}
            </div>
          </article>
        ))}
        {messages.data && !messages.data.messages.length && (
          <Empty title="No messages returned." icon="chat" />
        )}
      </section>
      <section className="panel">
        <h2>Reply draft</h2>
        <label>
          Review and edit before sending
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={6}
            placeholder="Ask the business copilot to help draft a reply."
          />
        </label>
        <Notice>
          Drafts are local and are never sent automatically. This checkout has
          no verified organization message-send endpoint.
        </Notice>
      </section>
    </>
  );
}
export function Settings() {
  const org = useWorkspace();
  const config = useData<Business>(`/widget/config/${org.id}`);
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Heading
        eyebrow="THE DETAILS THAT MAKE IT YOURS"
        title="Make yourself at home."
      />
      <LoadState {...config} retry={config.refresh} />
      <ProfileSettings />
      <IntegrationSettings orgId={org.id} />
      <section className="panel">
        <h2>Business profile</h2>
        <p className="muted">
          Current public information from your business API.
        </p>
        <div className="form-grid">
          <label>
            Business name
            <input value={config.data?.name || ""} readOnly />
          </label>
          <label>
            Contact phone
            <input value={config.data?.phone || ""} readOnly />
          </label>
          <label>
            Address
            <input value={config.data?.address || ""} readOnly />
          </label>
          <label>
            Business hours
            <input
              value={config.data?.hours || ""}
              placeholder="Not supplied"
              readOnly
            />
          </label>
        </div>
        <Notice>
          Profile editing, business hours, policies, and notification
          preferences have no verified JWT write route in this checkout. They
          remain read-only instead of saving only in your browser.
        </Notice>
      </section>
      <section className="panel">
        <h2>Booking policies & notifications</h2>
        <p className="muted">
          Cancellation windows, advance booking, and notification preferences
          are controlled by the backend. No values are inferred here.
        </p>
      </section>
      <section className="panel">
        <h2>Your website, connected.</h2>
        <p>
          Share your public business profile. This web console blocks framing by
          default; use a link rather than a broken iframe.
        </p>
        <code className="embed-code">{`<a href="/business/${org.id}">Book with Locogi</a>`}</code>
        <button
          className="button secondary small"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                `${window.location.origin}/business/${org.id}`,
              );
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Profile link copied" : "Copy profile link"}
        </button>
        <Notice>
          The existing embeddable widget requires its own hosted script and
          configured origins. No widget API key is exposed in this frontend.
        </Notice>
      </section>
      <section className="panel">
        <h2>Webhooks</h2>
        <p className="muted">
          Webhook configuration requires organization API-key authorization.
          Manage it through your approved backend administration flow; secret
          keys never enter this page.
        </p>
      </section>
    </>
  );
}
