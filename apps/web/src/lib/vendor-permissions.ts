import type { Membership } from "./contracts";

export function vendorPermissions(member: Membership) {
  const owner = member.role === "owner";
  const manager = member.role === "manager";
  return {
    viewRevenue: (owner || manager) && member.can_view_earnings !== false,
    editCatalog: (owner || manager) && member.can_manage_catalog !== false,
    updateBookings: owner && member.can_accept_bookings !== false,
    manageStaff: owner && member.can_manage_staff !== false,
    assignedOnly: !owner && !manager,
  };
}
