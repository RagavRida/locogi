import "server-only";
import { NextRequest } from "next/server";
import { ACCESS_COOKIE, upstream } from "./server";
import type { Membership } from "./contracts";
import { websiteToken } from "./auth0";

const state = globalThis as typeof globalThis & {
  locogiPlatformKeys?: Map<string, string>;
};
const keys = (state.locogiPlatformKeys ??= new Map<string, string>());
export function rememberPlatformKey(orgId: string, key: string) {
  keys.set(orgId, key);
}
export function forgetPlatformKey(orgId: string) {
  keys.delete(orgId);
}
export function platformKey(orgId: string) {
  const cached = keys.get(orgId);
  if (cached) return cached;
  try {
    const configured = JSON.parse(process.env.LOCOGI_ORG_API_KEYS || "{}");
    return typeof configured[orgId] === "string"
      ? (configured[orgId] as string)
      : undefined;
  } catch {
    return undefined;
  }
}
export async function membership(request: NextRequest, orgId: string) {
  const token = await websiteToken(request);
  if (!token) return null;
  const response = await upstream("/organizations/mine", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  const result = await response.json();
  const member = result.organizations?.find(
    (entry: { id: string }) => entry.id === orgId,
  );
  if (!member) return null;
  return {
    token,
    member: { ...member, role: member.role ?? member.memberRole } as Membership,
  };
}
