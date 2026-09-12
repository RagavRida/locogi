"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useUser } from "@auth0/nextjs-auth0/client";
import { safeImage } from "@/lib/contracts";
import { useSession } from "./providers";

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    chat: (
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5a9.5 9.5 0 0 1 19 0Z M7 10h10M7 14h6" />
    ),
    camera: (
      <>
        <path d="M8 5 6 8H3v12h18V8h-3l-2-3Z" />
        <circle cx="12" cy="13" r="4" />
      </>
    ),
    food: (
      <path d="M5 3v7m4-7v7M3 3v5a4 4 0 0 0 8 0V3M7 12v9M19 3v18m0-18c-5 3-5 10 0 10" />
    ),
    scissors: (
      <>
        <circle cx="6" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="m8 8 13 13M8 16 21 3M12 12l3-3" />
      </>
    ),
    health: <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6Z" />,
    ride: (
      <>
        <circle cx="5" cy="17" r="4" />
        <circle cx="19" cy="17" r="4" />
        <path d="m5 17 5-10 9 10H5l-3-8m6-6h5m3 2h3l2 6" />
      </>
    ),
    pin: (
      <>
        <path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z" />
        <circle cx="12" cy="10" r="2.5" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="3" />
        <path d="M7 3v4m10-4v4M3 11h18m-14 4h3m4 0h3" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="2" />
        <rect x="14" y="3" width="7" height="7" rx="2" />
        <rect x="3" y="14" width="7" height="7" rx="2" />
        <rect x="14" y="14" width="7" height="7" rx="2" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="7" r="4" />
        <path d="M1 21v-3a8 8 0 0 1 16 0v3m0-18a4 4 0 0 1 0 8m2 3a6 6 0 0 1 4 5v2" />
      </>
    ),
    chart: <path d="M3 3v18h18M7 16v-5m5 5V7m5 9V3" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="m9 3 1-2h4l1 2 3 2 3 1v4l-2 2 2 2v4l-3 1-3 2-1 2h-4l-1-2-3-2-3-1v-4l2-2-2-2V6l3-1Z" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    plus: <path d="M12 4v16M4 12h16" />,
    shield: (
      <>
        <path d="M12 2 3 6v6c0 6 9 10 9 10s9-4 9-10V6Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    star: <path d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.grid}
    </svg>
  );
}
export function Brand() {
  return (
    <Link href="/" className="brand" aria-label="Locogi home">
      <span className="brand-mark">
        <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
          <path
            d="M9 6v15a5 5 0 0 0 10 0V11a5 5 0 0 0-10 0v10m14-10v10"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
          />
        </svg>
      </span>
      locogi<span className="brand-period">.</span>
    </Link>
  );
}
export function Header() {
  const pathname = usePathname();
  const { user, loading, logout } = useSession();
  const { user: auth0User } = useUser();
  const profileName =
    auth0User?.name || auth0User?.nickname || auth0User?.email || "Account";
  const avatar = safeImage(auth0User?.picture);
  const [scrolled, setScrolled] = useState(false);
  const exploring =
    pathname.startsWith("/services") || pathname.startsWith("/business/");
  const bookings = pathname.startsWith("/bookings");
  const business =
    pathname.startsWith("/onboard") || pathname.startsWith("/dashboard");
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 24);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return (
    <header className={`site-header${scrolled ? " is-scrolled" : ""}`}>
      <div className="header-inner">
        <Brand />
        <nav aria-label="Main navigation">
          <Link
            className={exploring ? "active" : ""}
            aria-current={exploring ? "page" : undefined}
            aria-label="Explore services"
            title="Explore services"
            href="/services"
          >
            <Icon name="search" size={17} />
            <span className="nav-link-label">Explore services</span>
          </Link>
          <Link
            className={bookings ? "active" : ""}
            aria-current={bookings ? "page" : undefined}
            aria-label="My bookings"
            title="My bookings"
            href="/bookings"
          >
            <Icon name="calendar" size={17} />
            <span className="nav-link-label">My bookings</span>
          </Link>
          <Link
            href="/onboard"
            className={business ? "active" : ""}
            aria-current={business ? "page" : undefined}
            aria-label="For businesses"
            title="For businesses"
          >
            <Icon name="grid" size={17} />
            <span className="nav-link-label">
              For businesses <span className="nav-link-arrow">↗</span>
            </span>
          </Link>
        </nav>
        <div className="header-actions">
          {auth0User ? (
            <button
              className="text-button"
              aria-label="Sign out"
              title={`${profileName} · Sign out`}
              onClick={() => void logout().catch(() => undefined)}
            >
              <span className="auth0-avatar">
                {avatar ? (
                  <img src={avatar} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <Icon name="users" size={16} />
                )}
              </span>
              <span className="account-label profile-name">{profileName}</span>
            </button>
          ) : (
            <a
              className="text-button"
              href="/login"
              aria-label="Log in"
              title="Log in"
            >
              <span className="account-label">
                {loading ? "Account" : "Log in"}
              </span>
              <span className="account-icon">
                <Icon name="users" size={16} />
              </span>
            </a>
          )}
          <Link className="button small primary" href="/chat">
            Let’s chat <Icon name="arrow" size={16} />
          </Link>
        </div>
      </div>
    </header>
  );
}
export function Footer() {
  return (
    <footer className="footer">
      <div>
        <Brand />
        <p>Good things happen locally.</p>
      </div>
      <div>
        <Link href="/services">Explore</Link>
        <Link href="/onboard">For businesses</Link>
        <a href="/login">Your account</a>
      </div>
      <span>Locogi · Ask. Book. Done.</span>
    </footer>
  );
}
export function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Header />
      <main className="site-main">{children}</main>
      <Footer />
    </>
  );
}
export function Empty({
  title,
  children,
  icon = "search",
}: {
  title: string;
  children?: React.ReactNode;
  icon?: string;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}
export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="notice">
      <Icon name="shield" size={18} />
      <div>{children}</div>
    </div>
  );
}
export function LoadState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error?: string;
  retry?: () => void;
}) {
  if (error)
    return (
      <div className="error-box" role="alert">
        <span>{error}</span>
        {retry && (
          <button className="button small secondary" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    );
  return loading ? (
    <div className="loading-state" role="status">
      <span className="spinner" /> Loading live data…
    </div>
  ) : null;
}
export function Status({ value }: { value: string }) {
  return (
    <span
      className={`status status-${value.replace(/[^a-z_]/gi, "").toLowerCase()}`}
    >
      <span className="dot" />
      {value.replaceAll("_", " ")}
    </span>
  );
}
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  const path = usePathname();
  if (loading && !user) return <LoadState loading />;
  if (!user)
    return (
      <Empty title="A little hello, then you’re in." icon="shield">
        <p>Sign in to keep your conversations and bookings together.</p>
        <Link
          className="button primary"
          href={`/login?next=${encodeURIComponent(path)}`}
        >
          Continue with your phone <Icon name="arrow" />
        </Link>
      </Empty>
    );
  return <>{children}</>;
}
export const categories = [
  {
    name: "Photography",
    icon: "camera",
    query: "photographer",
    note: "Make it a moment",
    tone: "peach",
  },
  {
    name: "Restaurants",
    icon: "food",
    query: "restaurant",
    note: "Find your next favorite",
    tone: "lime",
  },
  {
    name: "Salons",
    icon: "scissors",
    query: "salon",
    note: "A little you-time",
    tone: "purple",
  },
  {
    name: "Dentists",
    icon: "health",
    query: "dentist",
    note: "Something to smile about",
    tone: "blue",
  },
  {
    name: "Rides",
    icon: "ride",
    query: "bike ride",
    note: "Good places await",
    tone: "pink",
  },
];
