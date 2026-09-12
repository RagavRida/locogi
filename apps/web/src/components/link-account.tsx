"use client";
import { useState } from "react";
import { useUser } from "@auth0/nextjs-auth0/client";
import { useSearchParams } from "next/navigation";
import { post } from "@/lib/client";
import { safeReturnTo } from "@/lib/return-to";
import { PageShell, Notice } from "./ui";

export default function LinkAccount() {
  const { user } = useUser();
  const search = useSearchParams();
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function complete(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      const result = await post<{ returnTo?: string }>(path, body);
      if (path.endsWith("send-link-otp")) setSent(true);
      else
        window.location.assign(
          safeReturnTo(search.get("returnTo") || result.returnTo),
        );
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not link this account.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageShell>
      <div className="page-container" id="content">
        <form
          className="auth-form"
          onSubmit={(event) => {
            event.preventDefault();
            void complete(
              sent ? "/api/session/link" : "/api/session/send-link-otp",
              sent ? { phone, otp, confirmLink: true } : { phone },
            );
          }}
        >
          <p className="eyebrow">SIGNED IN WITH AUTH0</p>
          <h2>Connect your Locogi account.</h2>
          <p className="muted">
            Welcome{user?.name ? `, ${user.name}` : ""}. Verify your phone once
            to connect bookings and business memberships to this Auth0 identity.
            Future website logins use Auth0.
          </p>
          <label>
            Phone number
            <input
              name="phone"
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(event) =>
                setPhone(event.target.value.replace(/\s/g, ""))
              }
              pattern="\+91[6-9][0-9]{9}"
              placeholder="+919876543210"
              required
              disabled={sent || busy}
            />
          </label>
          {sent && (
            <>
              <label>
                Verification code
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={otp}
                  onChange={(event) => setOtp(event.target.value)}
                  required
                  disabled={busy}
                />
              </label>
              <label className="checkbox-label">
                <input type="checkbox" required disabled={busy} />
                Link the Locogi account for this phone to my signed-in Auth0
                identity.
              </label>
            </>
          )}
          <Notice>
            In development OTP is{" "}
            <strong>logged to the API console, not sent by SMS.</strong>{" "}
            Telegram’s phone login remains unchanged.
          </Notice>
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
          <button className="button primary full" disabled={busy}>
            {busy
              ? "Please wait…"
              : sent
                ? "Verify phone & link account"
                : "Send linking code"}
          </button>
          {sent && (
            <button
              className="text-button"
              type="button"
              disabled={busy}
              onClick={() => {
                setSent(false);
                setOtp("");
              }}
            >
              Use another number or request a new code
            </button>
          )}
          <button
            className="text-button"
            type="button"
            disabled={busy}
            onClick={() => void complete("/api/session/exchange", {})}
          >
            Already linked? Retry API connection
          </button>
          <a className="text-button" href="/api/auth/logout">
            Use a different Auth0 account
          </a>
        </form>
      </div>
    </PageShell>
  );
}
