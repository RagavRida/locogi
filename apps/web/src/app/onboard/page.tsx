import Onboarding from "@/components/onboarding";
import { protectedPage } from "@/lib/protected-page";
export default async function Page() {
  return protectedPage(() => <Onboarding />, "/onboard");
}
