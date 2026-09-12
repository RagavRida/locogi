"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { WsClientMessage, WsServerMessage, WsTopic } from "@locogi/types";
import { api, invalidate, post, refreshSession } from "@/lib/client";
import type { Profile } from "@/lib/contracts";

type SocketState = "offline" | "connecting" | "live" | "reconnecting";
interface Session {
  user: Profile | null;
  loading: boolean;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
  wsState: SocketState;
  watch: (topic: WsTopic) => () => void;
  intent: string;
  setIntent: (intent: string) => void;
  uiType: string;
  setUiType: (type: string) => void;
}
const SessionContext = createContext<Session | null>(null);
export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("Missing session provider");
  return context;
}
export function Providers({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [correlation, setCorrelation] = useState("No request yet");
  const [wsState, setWsState] = useState<SocketState>("offline");
  const [intent, setIntent] = useState("None yet");
  const [uiType, setUiType] = useState("None yet");
  const socket = useRef<WebSocket | null>(null);
  const topics = useRef(new Map<string, { topic: WsTopic; count: number }>());
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setUser(await api<Profile>("/users/me"));
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    const network = (event: Event) =>
      setOffline((event as CustomEvent<boolean>).detail);
    const trace = (event: Event) =>
      setCorrelation((event as CustomEvent<string>).detail);
    const expired = () => setUser(null);
    window.addEventListener("locogi:network", network);
    window.addEventListener("locogi:correlation", trace);
    window.addEventListener("locogi:expired", expired);
    return () => {
      window.removeEventListener("locogi:network", network);
      window.removeEventListener("locogi:correlation", trace);
      window.removeEventListener("locogi:expired", expired);
    };
  }, []);
  const sendSocket = useCallback((message: WsClientMessage) => {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify(message));
  }, []);
  const watch = useCallback(
    (topic: WsTopic) => {
      const key = `${topic.kind}:${topic.id}`;
      const existing = topics.current.get(key);
      if (existing) existing.count += 1;
      else {
        topics.current.set(key, { topic, count: 1 });
        sendSocket({ action: "subscribe", topic });
      }
      return () => {
        const entry = topics.current.get(key);
        if (entry && --entry.count === 0) {
          topics.current.delete(key);
          sendSocket({ action: "unsubscribe", topic });
        }
      };
    },
    [sendSocket],
  );
  useEffect(() => {
    if (!user) {
      setWsState("offline");
      return;
    }
    let stopped = false;
    let attempt = 0;
    let reconnect: ReturnType<typeof setTimeout>;
    let heartbeat: ReturnType<typeof setInterval>;
    let connection: WebSocket | null = null;
    let lastFrame = Date.now();
    const schedule = () => {
      if (stopped) return;
      setWsState("reconnecting");
      reconnect = setTimeout(
        () => {
          void connect();
        },
        Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) +
          Math.random() * 500,
      );
    };
    const connect = async () => {
      setWsState(attempt ? "reconnecting" : "connecting");
      try {
        let credentials: { token: string };
        try {
          credentials = await api("/api/session/socket");
        } catch {
          await refreshSession();
          credentials = await api("/api/session/socket");
        }
        if (stopped) return;
        const url = new URL(
          process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001/ws",
        );
        url.searchParams.set("token", credentials.token);
        connection = new WebSocket(url);
        socket.current = connection;
        connection.onopen = () => {
          attempt = 0;
          lastFrame = Date.now();
          setWsState("live");
          invalidate();
          for (const entry of topics.current.values())
            sendSocket({ action: "subscribe", topic: entry.topic });
          heartbeat = setInterval(() => {
            if (Date.now() - lastFrame > 75000) connection?.close();
            else sendSocket({ action: "ping" });
          }, 30000);
        };
        connection.onmessage = (event) => {
          lastFrame = Date.now();
          try {
            const frame = JSON.parse(event.data) as WsServerMessage;
            if (
              [
                "booking.changed",
                "booking.created",
                "booking.updated",
                "message.received",
                "tracking.updated",
                "quote.received",
                "subscribed",
                "unsubscribed",
                "error",
                "pong",
              ].includes(frame.type)
            )
              invalidate();
          } catch {
            invalidate();
          }
        };
        connection.onerror = () => connection?.close();
        connection.onclose = () => {
          clearInterval(heartbeat);
          socket.current = null;
          schedule();
        };
      } catch {
        schedule();
      }
    };
    void connect();
    const resume = () => {
      if (document.visibilityState === "visible") invalidate();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      stopped = true;
      clearTimeout(reconnect);
      clearInterval(heartbeat);
      connection?.close();
      socket.current = null;
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [user?.id, sendSocket]);
  const logout = async () => {
    await post("/api/session/logout", {});
    setUser(null);
    topics.current.clear();
    invalidate();
    window.location.assign("/api/auth/logout");
  };
  return (
    <SessionContext.Provider
      value={{
        user,
        loading,
        reload,
        logout,
        wsState,
        watch,
        intent,
        setIntent,
        uiType,
        setUiType,
      }}
    >
      {offline && (
        <div className="network-banner" role="alert">
          Locogi API is unavailable. No live results can be shown.{" "}
          <button
            onClick={() => {
              invalidate();
              void reload();
            }}
          >
            Retry connection
          </button>
        </div>
      )}
      {children}
      {process.env.NODE_ENV === "development" && (
        <details className="dev-panel">
          <summary>
            <span className={`dot ${wsState === "live" ? "live" : ""}`} />{" "}
            Developer console
          </summary>
          <dl>
            <dt>Correlation ID</dt>
            <dd>{correlation}</dd>
            <dt>WebSocket</dt>
            <dd>{wsState}</dd>
            <dt>Last intent</dt>
            <dd>{intent}</dd>
            <dt>Rendered component</dt>
            <dd>{uiType}</dd>
          </dl>
          <p>Socket event → authorized REST refetch</p>
        </details>
      )}
    </SessionContext.Provider>
  );
}
export function useData<T>(path: string | null) {
  const [state, setState] = useState<{
    path: string | null;
    data?: T;
    error?: string;
    loading: boolean;
  }>({ path, loading: !!path });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    window.addEventListener("locogi:invalidate", refresh);
    return () => window.removeEventListener("locogi:invalidate", refresh);
  }, [refresh]);
  useEffect(() => {
    if (!path) {
      setState({ path, loading: false });
      return;
    }
    const controller = new AbortController();
    setState((previous) => ({
      path,
      data: previous.path === path ? previous.data : undefined,
      loading: true,
    }));
    api<T>(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ path, data, loading: false });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ path, error: error.message, loading: false });
      });
    return () => controller.abort();
  }, [path, revision]);
  return state.path === path
    ? { ...state, refresh }
    : { data: undefined, error: undefined, loading: !!path, refresh };
}
export function useTopic(kind: WsTopic["kind"], id?: string) {
  const { watch } = useSession();
  useEffect(() => (id ? watch({ kind, id }) : undefined), [watch, kind, id]);
}
