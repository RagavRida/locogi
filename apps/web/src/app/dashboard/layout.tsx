import { DashboardLayout } from "@/components/dashboard";
import "@copilotkit/react-ui/styles.css";
import { protectedPage } from "@/lib/protected-page";
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return protectedPage(
    () => <DashboardLayout>{children}</DashboardLayout>,
    "/dashboard",
  );
}
