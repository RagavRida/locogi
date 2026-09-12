import { Suspense } from "react";
import Chat from "@/components/chat";
import { protectedPage } from "@/lib/protected-page";
export default async function Page() {
  return protectedPage(
    () => (
      <Suspense>
        <Chat />
      </Suspense>
    ),
    "/chat",
  );
}
