import Bookings from "@/components/bookings";
import { protectedPage } from "@/lib/protected-page";
export default async function Page() {
  return protectedPage(() => <Bookings />, "/bookings");
}
