import "server-only";
import { initAuth0, type Session } from "@auth0/nextjs-auth0";
import { NextRequest, NextResponse } from "next/server";

let client: ReturnType<typeof initAuth0> | undefined;
export const auth0Fields = [
  "AUTH0_SECRET",
  "AUTH0_BASE_URL",
  "AUTH0_ISSUER_BASE_URL",
  "AUTH0_CLIENT_ID",
  "AUTH0_CLIENT_SECRET",
  "AUTH0_AUDIENCE",
] as const;
export function missingAuth0Configuration() {
  return auth0Fields.filter(
    (name) => !process.env[name] || /[<>]/.test(process.env[name]!),
  );
}
export function auth0Configured() {
  return missingAuth0Configuration().length === 0;
}
export function auth0() {
  if (!auth0Configured()) throw new Error("AUTH0_NOT_CONFIGURED");
  return (client ??= initAuth0({
    secret: process.env.AUTH0_SECRET,
    baseURL: process.env.AUTH0_BASE_URL,
    issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
    clientID: process.env.AUTH0_CLIENT_ID,
    clientSecret: process.env.AUTH0_CLIENT_SECRET,
    authorizationParams: {
      audience: process.env.AUTH0_AUDIENCE,
      scope: "openid profile email offline_access",
    },
    session: { rolling: false, absoluteDuration: 86400 },
  }));
}
export { safeReturnTo } from "./return-to";
export async function websiteSession(
  request: NextRequest,
): Promise<Session | null> {
  if (!auth0Configured()) return null;
  try {
    return (await auth0().getSession(request, new NextResponse())) ?? null;
  } catch {
    return null;
  }
}
export async function websiteToken(request: NextRequest) {
  const session = await websiteSession(request);
  const token = request.cookies.get("locogi_access")?.value;
  if (!token || typeof session?.locogiUserId !== "string") return null;
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    return payload.sub === session.locogiUserId ? token : null;
  } catch {
    return null;
  }
}
