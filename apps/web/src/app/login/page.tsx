import Link from "next/link";
import { redirect } from "next/navigation";
import {
  auth0Configured,
  missingAuth0Configuration,
  safeReturnTo,
} from "@/lib/auth0";

export default function Login({
  searchParams,
}: {
  searchParams: { returnTo?: string; next?: string; error?: string };
}) {
  const destination = safeReturnTo(searchParams.returnTo || searchParams.next);
  if (auth0Configured() && !searchParams.error)
    redirect(`/api/auth/login?returnTo=${encodeURIComponent(destination)}`);
  return (
    <main className="page-container" id="content">
      <p className="eyebrow">AUTH0 UNIVERSAL LOGIN</p>
      <h1>
        {auth0Configured()
          ? "Sign-in did not complete."
          : "Auth0 needs its tenant settings."}
      </h1>
      <p className="muted">
        {auth0Configured()
          ? "Try hosted login again. Your account has not been linked or changed by this page."
          : "Add these variables to the web app’s ignored .env.local file. Do not paste secret values into chat."}
      </p>
      {!auth0Configured() && (
        <ul>
          {missingAuth0Configuration().map((field) => (
            <li key={field}>
              <code>{field}</code>
            </li>
          ))}
        </ul>
      )}
      <p>
        Register the callback{" "}
        <code>http://localhost:3002/api/auth/callback</code> and create the
        Locogi API audience in Auth0.
      </p>
      {auth0Configured() && (
        <a
          className="button primary"
          href={`/api/auth/login?returnTo=${encodeURIComponent(destination)}`}
        >
          Continue with Auth0
        </a>
      )}
      <Link className="button secondary" href="/">
        Back to Locogi
      </Link>
    </main>
  );
}
