"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="page-container" id="content">
      <h1>Something didn’t load.</h1>
      <p>Your booking status has not been changed by this screen.</p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>
    </main>
  );
}
