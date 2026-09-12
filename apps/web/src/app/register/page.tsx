import { redirect } from "next/navigation";
import { auth0Configured } from "@/lib/auth0";
export default function Register() {
  redirect(
    auth0Configured()
      ? "/api/auth/signup?returnTo=%2Fonboard"
      : "/login?returnTo=%2Fonboard",
  );
}
