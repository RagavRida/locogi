import type {
  AgentReply,
  BookingType,
  ConversationContext,
  Request,
  ResourceSlot,
  UISchema,
  User,
} from "@locogi/types";

export type Profile = Pick<
  User,
  "id" | "name" | "phone" | "isVendor" | "isCustomer"
>;
export interface Membership {
  id: string;
  display_name: string;
  org_type: string;
  role: "owner" | "manager" | "staff" | "practitioner";
  can_accept_bookings?: boolean;
  can_manage_catalog?: boolean;
  can_manage_staff?: boolean;
  can_view_earnings?: boolean;
}
export interface Business {
  orgId: string;
  name: string;
  type: string;
  bookingTypes?: BookingType[];
  branding?: { logoUrl?: string; coverUrl?: string };
  address?: string | null;
  area?: string | null;
  phone?: string | null;
  rating?: number;
  hours?: string;
  portfolio?: { title: string; url: string; source?: string }[];
  reviews?: { id: string; author: string; text: string; rating: number }[];
}
export interface CatalogItem {
  id: string;
  name: string;
  description?: string | null;
  price: number | string | null;
  currency?: string;
  section?: string;
  imageUrl?: string | null;
  isAvailable?: boolean;
}
export type CatalogResponse = {
  sections:
    Record<string, CatalogItem[]> | { name: string; items: CatalogItem[] }[];
};
export interface Resource {
  id: string;
  name: string;
  resource_type?: string;
  specialization?: string | null;
  qualification?: string | null;
  experience_years?: number;
  price_per_slot?: number | null;
}
export interface Slot {
  id: ResourceSlot["id"];
  time: ResourceSlot["slotTime"];
  duration: ResourceSlot["durationMinutes"];
  available: number;
  price: number | null;
}
export interface Booking {
  id: Request["id"];
  title?: string;
  description?: string;
  status: Request["status"];
  bookingType: BookingType;
  price?: number | null;
  agreedPrice?: number | null;
  slotTime?: string | null;
  vendorId?: string | null;
  vendorName?: string | null;
  categories?: string[];
  canCancel?: boolean;
  canTrack?: boolean;
  customerName?: string | null;
  createdAt?: string;
}
export interface Tracking {
  available: boolean;
  why?: string;
  vendorName?: string | null;
  lat?: number;
  lng?: number;
  etaMinutes?: number | null;
  distanceKm?: number | null;
  phase?: string;
  events?: { phase: string; timestamp: string }[];
}
export type CommerceComponent =
  | "catalog_grid"
  | "cart_summary"
  | "resource_picker"
  | "booking_confirmation"
  | "order_status"
  | "offer_applied"
  | "phone_prompt"
  | "confirmation_prompt"
  | "error";
export interface ChatSchema {
  type: UISchema["type"] | CommerceComponent;
  data: Record<string, unknown>;
}
export type ChatReply = Omit<AgentReply, "ui"> & {
  ui?: ChatSchema;
  handled?: boolean;
  sessionId?: string;
};
export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string | null;
  ui?: ChatSchema;
  timestamp: string;
}
export type ContextResponse = {
  context: ConversationContext | null;
  session?: {
    phase?: string;
    cart?: {
      id?: string;
      name: string;
      quantity?: number;
      qty?: number;
      price: number;
    }[];
    total?: number;
    offer?: { code: string; discount: number; newTotal: number };
  };
};
export interface SearchHit {
  id: string;
  content?: string;
  metadata: {
    name?: string;
    organization_id?: string;
    base_price?: number;
    image_url?: string;
  };
}
export interface Stats {
  completedJobs?: number;
  rating?: number;
  quoted?: number;
  accepted?: number;
  earnings?: number;
  acceptanceRate?: number;
}
export function catalogSections(
  response?: CatalogResponse,
): { name: string; items: CatalogItem[] }[] {
  if (!response?.sections) return [];
  return Array.isArray(response.sections)
    ? response.sections
    : Object.entries(response.sections).map(([name, items]) => ({
        name,
        items,
      }));
}
export function money(
  value: number | string | null | undefined,
  currency = "INR",
) {
  if (value == null || !Number.isFinite(Number(value)))
    return "Price not supplied";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number(value));
  } catch {
    return String(value);
  }
}
export function when(value?: string | null) {
  if (!value) return "Time not supplied";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time unavailable"
    : date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}
export function safeImage(value?: string | null) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
