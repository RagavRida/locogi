import { redirect } from "next/navigation";
import { unstable_noStore as noStore } from "next/cache";
import { auth0, auth0Configured, safeReturnTo } from "./auth0";

export async function protectedPage(
  render: () => React.JSX.Element | Promise<React.JSX.Element>,
  returnTo: string,
  linked = true,
) {
  noStore();
  const destination = safeReturnTo(returnTo);
  if (!auth0Configured())
    redirect(`/login?returnTo=${encodeURIComponent(destination)}`);
  return auth0().withPageAuthRequired(
    async () => {
      const session = await auth0().getSession();
      if (linked && !session?.locogiUserId)
        redirect(`/account/link?returnTo=${encodeURIComponent(destination)}`);
      return await render();
    },
    { returnTo: destination },
  )({});
}
