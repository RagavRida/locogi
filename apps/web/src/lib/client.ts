"use client";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
let refreshing: Promise<void> | undefined;
export function invalidate() {
  window.dispatchEvent(new Event("locogi:invalidate"));
}
function emit(name: string, detail: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}
export async function refreshSession() {
  if (!refreshing)
    refreshing = fetch("/api/session/refresh", {
      method: "POST",
      credentials: "same-origin",
    })
      .then((response) => {
        if (!response.ok)
          throw new ApiError("Please sign in again.", response.status);
      })
      .finally(() => {
        refreshing = undefined;
      });
  return refreshing;
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const url = path.startsWith("/api/") ? path : `/api/backend${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...options,
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...options.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    emit("locogi:network", true);
    throw new ApiError(
      "Cannot reach Locogi. Check your connection and retry.",
      0,
    );
  }
  const correlation = response.headers.get("x-correlation-id");
  if (correlation) emit("locogi:correlation", correlation);
  emit("locogi:network", response.status >= 500 && response.status !== 501);
  if (
    response.status === 401 &&
    retry &&
    !url.startsWith("/api/auth/") &&
    !url.startsWith("/api/session/")
  ) {
    try {
      await refreshSession();
    } catch (error) {
      emit("locogi:expired", true);
      throw error;
    }
    return api<T>(path, options, false);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      typeof data.message === "string"
        ? data.message
        : `Request failed (${response.status}).`,
      response.status,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export const post = <T>(path: string, data: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(data) });
