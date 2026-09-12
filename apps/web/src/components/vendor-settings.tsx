"use client";
import { useState } from "react";
import { api, invalidate, post } from "@/lib/client";
import { useData, useSession } from "./providers";
import { LoadState, Notice } from "./ui";

export function ProfileSettings() {
  const { user, reload } = useSession();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="panel"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setError("");
        setMessage("");
        try {
          await api("/users/me", {
            method: "PATCH",
            body: JSON.stringify({ name: form.get("name") }),
          });
          await reload();
          setMessage("Profile saved by the API.");
        } catch (error) {
          setError(
            error instanceof Error ? error.message : "Could not save profile.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Your account profile</h2>
      <label>
        Your name
        <input
          name="name"
          defaultValue={user?.name || ""}
          minLength={2}
          maxLength={100}
          required
        />
      </label>
      <button className="button secondary" disabled={busy}>
        {busy ? "Saving…" : "Save name"}
      </button>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="error-box">
          {error}
        </p>
      )}
    </form>
  );
}
export function IntegrationSettings({ orgId }: { orgId: string }) {
  const connection = useData<{ connected: boolean }>(
    `/api/business/${orgId}/connection`,
  );
  const keys = useData<{
    keys: { id: string; label?: string; prefix: string; active: boolean }[];
  }>(`/api/business/${orgId}/keys`);
  const webhooks = useData<{
    webhooks: { id: string; url: string; events: string[] }[];
  }>(connection.data?.connected ? `/api/business/${orgId}/webhooks` : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      invalidate();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "The operation failed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="panel">
        <h2>Platform connection</h2>
        <LoadState {...connection} retry={connection.refresh} />
        <p>
          {connection.data?.connected
            ? "Connected: catalog, bookings, and resource reads use this business’s server-held integration key."
            : "Connect an existing business, or onboard a new one. Only the owner can create this connection."}
        </p>
        <button
          className="button primary"
          disabled={busy || connection.loading || connection.data?.connected}
          onClick={() => {
            if (
              window.confirm(
                "Create an integration API key for this web workspace? It stays on the server and can be revoked below.",
              )
            )
              void perform(() => post(`/api/business/${orgId}/connection`, {}));
          }}
        >
          {busy
            ? "Connecting…"
            : connection.data?.connected
              ? "Platform connected"
              : "Connect this workspace"}
        </button>
        <Notice>
          In development this connection is held in server memory. After a
          web-server restart, reconnect or configure a server-side secret store.
          No raw API key appears on this page.
        </Notice>
        {connection.data?.connected && (
          <a
            className="button secondary small"
            href={`/api/business/${orgId}/connection?download=1`}
          >
            Download your integration key securely
          </a>
        )}
        <LoadState {...keys} retry={keys.refresh} />
        {keys.data?.keys.map((key) => (
          <div className="analytic-row" key={key.id}>
            <div>
              <strong>{key.label || "Integration key"}</strong>
              <p>
                {key.prefix}… · {key.active ? "Active" : "Revoked"}
              </p>
            </div>
            <button
              className="button danger small"
              disabled={busy || !key.active}
              onClick={() => {
                if (
                  window.confirm(
                    "Revoke this key? Integrations using it will stop working.",
                  )
                )
                  void perform(() =>
                    api(
                      `/api/business/${orgId}/keys/${encodeURIComponent(key.id)}`,
                      { method: "DELETE" },
                    ),
                  );
              }}
            >
              Revoke
            </button>
          </div>
        ))}
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Webhook subscriptions</h2>
        <LoadState {...webhooks} retry={webhooks.refresh} />
        {webhooks.data?.webhooks.map((webhook) => (
          <div className="analytic-row" key={webhook.id}>
            <div>
              <strong>{webhook.url}</strong>
              <p>{webhook.events?.join(", ")}</p>
            </div>
            <button
              className="button danger small"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Remove this webhook subscription?"))
                  void perform(() =>
                    api(
                      `/api/business/${orgId}/webhooks/${encodeURIComponent(webhook.id)}`,
                      { method: "DELETE" },
                    ),
                  );
              }}
            >
              Remove
            </button>
          </div>
        ))}
        {webhooks.data && !webhooks.data.webhooks.length && (
          <p>No webhook subscriptions.</p>
        )}
        <Notice>
          Creating webhook subscriptions requires a secure signing-secret
          handoff to your receiving server. This page lists and removes
          subscriptions; it does not discard a new signing secret or pretend
          that delivery is configured.
        </Notice>
      </section>
    </>
  );
}
