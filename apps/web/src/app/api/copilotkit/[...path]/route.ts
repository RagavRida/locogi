import { NextRequest } from "next/server";
import { forwardCopilot } from "@/lib/copilot-proxy";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
function handler(
  request: NextRequest,
  { params }: { params: { path: string[] } },
) {
  return forwardCopilot(request, params.path);
}
export { handler as GET, handler as POST };
