"use client";
import { CopilotKit } from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { useData } from "./providers";
import { Component, type ReactNode } from "react";
import type { Membership } from "@/lib/contracts";
import { vendorPermissions } from "@/lib/vendor-permissions";
import { useCopilotReadable } from "@copilotkit/react-core";

class SidebarBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <details className="copilot-fallback">
        <summary>Business Copilot unavailable</summary>
        <p>
          Check the Copilot Cloud key and the locogi-vendor-assistant runtime
          configuration. Your dashboard is still available.
        </p>
      </details>
    ) : (
      this.props.children
    );
  }
}
function PermissionContext({ member }: { member: Membership }) {
  const permissions = vendorPermissions(member);
  useCopilotReadable(
    {
      description:
        "Current vendor membership and permission boundaries, returned by the authenticated API. These are not changeable through chat. Politely explain unavailable permissions.",
      value: { role: member.role, permissions, organizationId: member.id },
    },
    [
      member.id,
      member.role,
      permissions.viewRevenue,
      permissions.editCatalog,
      permissions.updateBookings,
    ],
  );
  return null;
}

export default function VendorCopilot({
  member,
  children,
}: {
  member: Membership;
  children: ReactNode;
}) {
  const orgId = member.id;
  const runtime = useData<{ available: boolean; configured: boolean }>(
    "/api/copilotkit/status",
  );
  return (
    <div className="vendor-copilot" data-testid="vendor-copilot">
      <CopilotKit
        publicApiKey={process.env.NEXT_PUBLIC_COPILOT_CLOUD_PUBLIC_API_KEY}
        runtimeUrl="/api/copilotkit"
        agent="locogi-vendor-assistant"
        headers={{ "x-org-id": orgId }}
        showDevConsole={false}
      >
        <PermissionContext member={member} />
        {children}
        <SidebarBoundary>
          <CopilotSidebar
            defaultOpen={false}
            clickOutsideToClose={true}
            labels={{
              title: "Locogi Business Copilot",
              placeholder:
                "Ask about bookings, services, or business insights…",
              initial: runtime.data?.available
                ? "Ask about orders today, catalog updates, or this week’s revenue. The backend verifies every action against your role."
                : "The CopilotKit sidebar is installed. Its runtime is not connected yet; business answers and actions are unavailable until a secure backend runtime is configured.",
            }}
            instructions="You are the Locogi vendor-only business assistant. Use registered actions and current authorized context. Owner: business management. Manager: catalog and analytics, read bookings. Staff/practitioner: only assigned bookings and schedule, no organization revenue. Politely explain restrictions. Never invent metrics, customer conversations, unavailable duration fields, or completed mutations. Wait for explicit confirmation before any live change."
          />
        </SidebarBoundary>
      </CopilotKit>
    </div>
  );
}
