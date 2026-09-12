import { Suspense } from "react";
import Services from "@/components/services";
export default function Page() {
  return (
    <Suspense>
      <Services />
    </Suspense>
  );
}
