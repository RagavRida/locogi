"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { invalidate, post } from "@/lib/client";
import { useSession } from "./providers";
import { Icon, Notice, PageShell, RequireAuth } from "./ui";

interface OnboardingResult {
  organizationId: string;
  displayName: string;
  description?: string;
  stats?: {
    catalogItems?: number;
    resources?: number;
    slotsGenerated?: number;
  };
  platformConnected: boolean;
}
function SetupBusiness() {
  const [description, setDescription] = useState("");
  const [city, setCity] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState<OnboardingResult | null>(null);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const { reload } = useSession();
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (locked.current || result) return;
    locked.current = true;
    setBusy(true);
    setElapsed(0);
    setError("");
    try {
      const response = await post<OnboardingResult>("/api/onboard", {
        description,
        ...(city.trim() ? { city: city.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      });
      setResult(response);
      invalidate();
      await reload();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Onboarding did not complete.",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="onboard-layout">
      <div className="onboard-story">
        <span className="eyebrow">FOR THE PEOPLE BEHIND THE BUSINESS</span>
        <h1>
          Your business.
          <br />
          <span className="hero-accent">One description away.</span>
        </h1>
        <p>
          Tell your story. Your AI agent sets up the storefront, catalog,
          people, and availability.
        </p>
        <div className="onboard-benefits">
          {[
            ["food", "A catalog that knows your craft"],
            ["users", "Your people, ready to book"],
            ["calendar", "Availability built around you"],
            ["chat", "An agent to handle the conversation"],
          ].map(([icon, text]) => (
            <div key={text}>
              <Icon name={icon} />
              <span>{text}</span>
            </div>
          ))}
        </div>
        <Link className="inline-link" href="/chat">
          Looking for a service instead? Customer chat →
        </Link>
      </div>
      <section className="panel onboard-panel">
        {result ? (
          <div role="status">
            <span className="onboard-success">
              <Icon name="check" size={30} />
            </span>
            <p className="eyebrow">CREATED BY YOUR BACKEND</p>
            <h2>{result.displayName}</h2>
            <p>{result.description}</p>
            <div className="onboard-results">
              {[
                ["Catalog items", result.stats?.catalogItems],
                ["Resources", result.stats?.resources],
                ["Slots generated", result.stats?.slotsGenerated],
              ].map(([label, value]) => (
                <div key={label}>
                  <strong>{value ?? "Not reported"}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <Notice>
              {result.platformConnected
                ? "The integration key is retained on the web server, never shown in page content. Your workspace can read the platform API."
                : "The API returned no integration key. The owner can connect the workspace in Settings."}
            </Notice>
            <Link
              className="button primary full"
              href={`/dashboard?orgId=${encodeURIComponent(result.organizationId)}`}
            >
              Go to Dashboard <Icon name="arrow" />
            </Link>
            <Link
              className="button secondary full"
              href={`/business/${encodeURIComponent(result.organizationId)}`}
            >
              Preview your storefront
            </Link>
          </div>
        ) : (
          <form onSubmit={submit}>
            <h2>Tell us about your business.</h2>
            <p>
              Name, services, prices, team, and working hours. Write it like
              you’d explain it to a friend.
            </p>
            <label>
              Describe your business
              <textarea
                autoFocus
                rows={9}
                minLength={10}
                maxLength={5000}
                required
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                disabled={busy}
                placeholder="I run a photography studio in Hyderabad. We offer full-day wedding shoots for ₹25,000 and pre-wedding shoots for ₹8,000. Our photographers are Anikanth and Rahul. We’re open Monday–Saturday, 9am–7pm."
              />
            </label>
            <div className="form-grid">
              <label>
                City (optional)
                <input
                  value={city}
                  onChange={(event) => setCity(event.target.value)}
                  maxLength={100}
                  disabled={busy}
                  placeholder="Hyderabad"
                />
              </label>
              <label>
                Business phone (optional)
                <input
                  type="tel"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  maxLength={20}
                  disabled={busy}
                  placeholder="+91…"
                />
              </label>
            </div>
            {busy && (
              <div className="onboarding-progress" role="status">
                <span className="spinner" />
                <div>
                  <strong>AI is setting up your business…</strong>
                  <p>
                    Waiting for the backend · {elapsed}s. We’ll show what was
                    actually created when it responds.
                  </p>
                </div>
              </div>
            )}
            {error && (
              <div className="error-box" role="alert">
                {error}
                <Link href="/dashboard">Check My businesses →</Link>
              </div>
            )}
            <button
              className="button primary full"
              disabled={busy || description.trim().length < 10}
            >
              {busy
                ? "Setting up your business…"
                : "Create my business with AI"}
              <Icon name="arrow" />
            </button>
            <p className="auth-note">
              Submitting creates a real business using your configured AI
              service. Nothing is created by the preview text.
            </p>
          </form>
        )}
      </section>
    </div>
  );
}
export default function Onboarding() {
  return (
    <PageShell>
      <main className="page-container" id="content">
        <RequireAuth>
          <SetupBusiness />
        </RequireAuth>
      </main>
    </PageShell>
  );
}
