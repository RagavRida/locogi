import { Suspense } from "react";
import LinkAccount from "@/components/link-account";
import { protectedPage } from "@/lib/protected-page";
export default async function Page() {
  return protectedPage(
    () => (
      <Suspense>
        <LinkAccount />
      </Suspense>
    ),
    "/account/link",
    false,
  );
}
