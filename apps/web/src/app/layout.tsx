import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import Auth0Provider from "@/components/auth0-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Locogi — Ask. Book. Done.", template: "%s · Locogi" },
  description:
    "ChatGPT for local services. Discover local businesses, talk to their AI agents, and book your next great experience.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <a className="skip-link" href="#content">
          Skip to content
        </a>
        <Auth0Provider>
          <Providers>{children}</Providers>
        </Auth0Provider>
      </body>
    </html>
  );
}
