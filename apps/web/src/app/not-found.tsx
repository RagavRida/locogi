import Link from "next/link";
export default function NotFound() {
  return (
    <main className="page-container" id="content">
      <p className="eyebrow">404 · A little off the map</p>
      <h1>Let’s find your way back.</h1>
      <Link className="button primary" href="/">
        Back to Locogi →
      </Link>
    </main>
  );
}
