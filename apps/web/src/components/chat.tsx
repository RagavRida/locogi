"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, invalidate, post } from "@/lib/client";
import type { Business, ChatMessage, ChatReply } from "@/lib/contracts";
import { useData, useSession } from "./providers";
import { Brand, categories, Icon, LoadState, Notice, RequireAuth } from "./ui";
import { ServerCard } from "./registry";

function Conversation({
  orgId,
  initialPrompt,
}: {
  orgId?: string;
  initialPrompt: string;
}) {
  const { user, wsState, setIntent } = useSession();
  const business = useData<Business>(
    orgId ? `/widget/config/${encodeURIComponent(orgId)}` : null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(!orgId);
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<
    {
      id?: string;
      name?: string;
      canonicalName?: string;
      canonical_name?: string;
    }[]
  >([]);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const lock = useRef(false);
  const sessionId = useRef<string>();
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (orgId) return;
    const controller = new AbortController();
    setHistoryLoading(true);
    api<{ messages: ChatMessage[] }>("/chat/history", {
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) {
          setMessages(data.messages);
          setError("");
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setHistoryLoading(false);
      });
    return () => controller.abort();
  }, [orgId, historyAttempt]);
  useEffect(() => {
    setSuggestions([]);
    if (!draft.trim()) return;
    const controller = new AbortController();
    api<{ suggestions: typeof suggestions }>(
      `/categories/search?q=${encodeURIComponent(draft)}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted) setSuggestions(data.suggestions || []);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [draft]);
  useEffect(() => {
    bottom.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "end",
    });
  }, [messages, busy]);
  const appendReply = useCallback(
    (reply: ChatReply) => {
      if (reply.sessionId) sessionId.current = reply.sessionId;
      setMessages((previous) => [
        ...previous,
        {
          id: crypto.randomUUID(),
          role: "agent",
          text: reply.message || null,
          ui: reply.ui,
          timestamp: new Date().toISOString(),
        },
      ]);
      if (reply.intent) setIntent(reply.intent);
      invalidate();
    },
    [setIntent],
  );
  async function send(text: string) {
    const message = text.trim();
    if (!message || lock.current || historyLoading) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setDraft("");
    setSuggestions([]);
    setMessages((previous) => [
      ...previous,
      {
        id: crypto.randomUUID(),
        role: "user",
        text: message,
        timestamp: new Date().toISOString(),
      },
    ]);
    try {
      const reply = await post<ChatReply>("/chat", {
        message,
        ...(orgId ? { orgId } : {}),
        ...(sessionId.current ? { sessionId: sessionId.current } : {}),
      });
      appendReply(reply);
      return reply;
    } catch (error) {
      setError(
        `${error instanceof Error ? error.message : "The message could not be completed."} If the response was interrupted, check your bookings before repeating a confirmation.`,
      );
      return undefined;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function select(bookingId: string, forIntent?: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      appendReply(
        await post<ChatReply>("/chat/select", { bookingId, forIntent }),
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not select this booking.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const latestAgent = [...messages]
    .reverse()
    .find((message) => message.role === "agent")?.id;
  return (
    <div className="chat-layout" id="content">
      <aside className="chat-sidebar">
        <Brand />
        <Link className="button secondary full" href="/services">
          <Icon name="plus" size={18} /> Find a business
        </Link>
        <span className="mini-label">YOUR LOCAL LIFE</span>
        <Link href="/services">
          <Icon name="search" size={18} /> Explore services
        </Link>
        <Link href="/bookings">
          <Icon name="calendar" size={18} /> My bookings
        </Link>
        {user?.isVendor && (
          <Link href="/dashboard">
            <Icon name="grid" size={18} /> Switch to vendor workspace
          </Link>
        )}
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <span>✧</span>
            <p>
              No forms to figure out.
              <br />
              Just say what you need.
            </p>
          </div>
          <div className="account-chip">
            <span>{user?.name?.slice(0, 1) || "Y"}</span>
            <div>
              <strong>{user?.name || "Your account"}</strong>
              <small>Customer workspace</small>
            </div>
          </div>
        </div>
      </aside>
      <section className="chat-main">
        <header className="chat-header">
          <div className="agent-avatar">l.</div>
          <div>
            <h1>{business.data?.name || "Your local, on call."}</h1>
            <p>
              {orgId ? "Business agent" : "Locogi assistant"} <span>·</span>{" "}
              <span className={`dot ${wsState === "live" ? "live" : ""}`} />{" "}
              {wsState === "live"
                ? "Live updates connected"
                : "Live updates reconnecting"}
            </p>
          </div>
          <span
            className="integration-badge"
            title="Backend integration; the API does not report which provider executed each response."
          >
            OpenRouter · GPT-4.1 integration
          </span>
          <Link href="/services" className="text-button">
            Explore ↗
          </Link>
        </header>
        <div className="messages-area">
          <LoadState
            loading={historyLoading || business.loading}
            error={business.error}
            retry={business.refresh}
          />
          {orgId && (
            <p className="history-note">
              This conversation is scoped to this business. Business-specific
              history is not available from this API.
            </p>
          )}
          {!messages.length && !historyLoading && (
            <div className="chat-welcome">
              <span className="welcome-spark">✳</span>
              <p className="eyebrow">
                BIG PLANS. LITTLE ERRANDS. EVERYTHING BETWEEN.
              </p>
              <h2>
                What can we make
                <br />
                <span className="muted">happen today?</span>
              </h2>
              <p>Ask in your own words. Your agent takes it from there.</p>
              <div className="prompt-grid">
                {[
                  {
                    text: "Find a photographer for my wedding",
                    icon: "camera",
                  },
                  { text: "A dinner spot for a special evening", icon: "food" },
                  { text: "I need a haircut this weekend", icon: "scissors" },
                  { text: "Show me my bookings", icon: "calendar" },
                ].map((prompt) => (
                  <button
                    key={prompt.text}
                    onClick={() => setDraft(prompt.text)}
                  >
                    <Icon name={prompt.icon} />
                    <span>{prompt.text}</span>
                    <span>↗</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="messages" role="log" aria-label="Conversation">
            {messages.map((message) => (
              <article
                key={message.id}
                className={`message message-${message.role}`}
              >
                <div className="message-avatar">
                  {message.role === "agent" ? "l." : "Y"}
                </div>
                <div className="message-content">
                  <span className="message-author">
                    {message.role === "agent"
                      ? business.data?.name || "Locogi"
                      : "You"}
                  </span>
                  {message.text && (
                    <div className="message-text">{message.text}</div>
                  )}
                  {message.role === "agent" && message.ui && (
                    <ServerCard
                      schema={message.ui}
                      orgId={orgId}
                      send={send}
                      select={select}
                      busy={busy}
                      active={message.id === latestAgent}
                    />
                  )}
                </div>
              </article>
            ))}
            {busy && (
              <div className="thinking" role="status">
                <span className="agent-avatar">l.</span>
                <span className="thinking-dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span>Agent is thinking…</span>
              </div>
            )}
          </div>
          <div ref={bottom} />
        </div>
        <div className="composer-area">
          {error && (
            <div className="error-box" role="alert">
              {error}
              {!messages.length && (
                <button
                  className="text-button"
                  onClick={() => setHistoryAttempt((value) => value + 1)}
                >
                  Retry history
                </button>
              )}
            </div>
          )}
          {suggestions.length > 0 && (
            <div className="suggestions" aria-label="Category suggestions">
              {suggestions.slice(0, 6).map((suggestion, index) => (
                <button
                  key={suggestion.id || index}
                  onClick={() =>
                    setDraft(
                      suggestion.name ||
                        suggestion.canonicalName ||
                        suggestion.canonical_name ||
                        "",
                    )
                  }
                >
                  {suggestion.name ||
                    suggestion.canonicalName ||
                    suggestion.canonical_name}
                </button>
              ))}
            </div>
          )}
          <form
            className="chat-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
          >
            <textarea
              rows={1}
              aria-label="Message the agent"
              placeholder={
                orgId
                  ? "Ask this business anything…"
                  : "Tell us what you’re looking for…"
              }
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={2000}
              disabled={busy || historyLoading}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
            />
            <button
              className="send-button"
              aria-label="Send message"
              disabled={busy || historyLoading || !draft.trim()}
            >
              ↑
            </button>
          </form>
          <p className="composer-note">
            <Icon name="shield" size={13} /> You confirm before anything
            changes. AI can make mistakes; review your booking details.
          </p>
        </div>
      </section>
    </div>
  );
}
export default function Chat() {
  const search = useSearchParams();
  const orgId = search.get("orgId") || undefined;
  const { user } = useSession();
  return (
    <RequireAuth>
      <Conversation
        key={`${user?.id}:${orgId || "general"}`}
        orgId={orgId}
        initialPrompt={search.get("prompt") || ""}
      />
    </RequireAuth>
  );
}
