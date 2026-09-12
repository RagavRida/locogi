"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  catalogSections,
  money,
  safeImage,
  type Business,
  type CatalogResponse,
  type SearchHit,
} from "@/lib/contracts";
import { useData } from "./providers";
import { categories, Empty, Icon, LoadState, PageShell } from "./ui";

export function BusinessCard({ orgId }: { orgId: string }) {
  const business = useData<Business>(
    `/widget/config/${encodeURIComponent(orgId)}`,
  );
  const catalog = useData<CatalogResponse>(
    `/widget/catalog/${encodeURIComponent(orgId)}`,
  );
  const items = catalogSections(catalog.data)
    .flatMap((section) => section.items)
    .slice(0, 3);
  if (business.loading || business.error)
    return (
      <article className="business-card">
        <LoadState {...business} retry={business.refresh} />
      </article>
    );
  if (!business.data) return null;
  const info = business.data;
  const image = safeImage(info.branding?.coverUrl || info.branding?.logoUrl);
  return (
    <article className="business-card">
      <Link
        href={`/business/${encodeURIComponent(orgId)}`}
        className="business-cover"
      >
        {image ? (
          <img src={image} alt={info.name} loading="lazy" />
        ) : (
          <div className="cover-fallback">
            <Icon
              name={
                categories.find((category) =>
                  info.type?.includes(category.query),
                )?.icon || "grid"
              }
              size={45}
            />
            <span>{info.type?.replaceAll("_", " ") || "Local business"}</span>
          </div>
        )}
        <span className="cover-badge">
          <Icon name="chat" size={13} /> Chat with its agent
        </span>
      </Link>
      <div className="business-card-body">
        <div className="business-card-title">
          <Link href={`/business/${encodeURIComponent(orgId)}`}>
            <h3>{info.name}</h3>
          </Link>
          {info.rating != null && (
            <span className="rating">
              <Icon name="star" size={14} />
              {info.rating}
            </span>
          )}
        </div>
        {info.area && (
          <p className="location">
            <Icon name="pin" size={14} />
            {info.area}
          </p>
        )}
        <div className="catalog-preview">
          <LoadState {...catalog} retry={catalog.refresh} />
          {!catalog.loading && !catalog.error && !items.length && (
            <p className="muted">No catalog items available.</p>
          )}
          {items.map((item) => (
            <div key={item.id}>
              <span>{item.name}</span>
              <strong>{money(item.price, item.currency)}</strong>
            </div>
          ))}
        </div>
        <Link
          className="button secondary full"
          href={`/chat?orgId=${encodeURIComponent(orgId)}`}
        >
          Chat with Agent <Icon name="arrow" size={17} />
        </Link>
      </div>
    </article>
  );
}
export default function Services() {
  const search = useSearchParams();
  const router = useRouter();
  const query = search.get("q") || "";
  const [draft, setDraft] = useState(query);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
    null,
  );
  const [locationMessage, setLocationMessage] = useState("Use my location");
  const parameters = new URLSearchParams({ q: query });
  if (coords) {
    parameters.set("lat", String(coords.lat));
    parameters.set("lng", String(coords.lng));
  }
  const result = useData<{ results: SearchHit[] }>(
    query ? `/search/catalog?${parameters}` : null,
  );
  const ids = [
    ...new Set(
      result.data?.results
        .map((hit) => hit.metadata?.organization_id)
        .filter((id): id is string => !!id),
    ),
  ];
  function locate() {
    if (!navigator.geolocation) {
      setLocationMessage("Location is not supported by this browser");
      return;
    }
    setLocationMessage("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCoords({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
        setLocationMessage("Location included in search");
      },
      () =>
        setLocationMessage(
          "Location unavailable — add your area to the search",
        ),
      { timeout: 10000 },
    );
  }
  function choose(value: string) {
    setDraft(value);
    router.push(`/services?q=${encodeURIComponent(value)}`);
  }
  return (
    <PageShell>
      <div className="page-container discovery" id="content">
        <div className="discovery-heading">
          <p className="eyebrow">YOUR NEXT FAVORITE, NEARBY</p>
          <h1>
            Good things.
            <br />
            <span className="muted">Just around the corner.</span>
          </h1>
          <p>
            Tell us what you’re looking for. We’ll help you find your people.
          </p>
        </div>
        <form
          className="discovery-search"
          onSubmit={(event) => {
            event.preventDefault();
            choose(draft.trim());
          }}
        >
          <Icon name="search" size={23} />
          <input
            aria-label="Search local services"
            placeholder="Wedding photographer in Hyderabad…"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={500}
            required
          />
          <button className="button primary">
            Find services <Icon name="arrow" size={18} />
          </button>
        </form>
        <button className="location-button" onClick={locate}>
          <Icon name="pin" size={15} />
          {locationMessage}
        </button>
        <div className="category-filters" aria-label="Service categories">
          {categories.map((category) => (
            <button
              key={category.name}
              className={query === category.query ? "selected" : ""}
              onClick={() => choose(category.query)}
            >
              <Icon name={category.icon} size={19} />
              {category.name}
            </button>
          ))}
        </div>
        <div className="results-heading">
          <h2>
            {query ? `Results for “${query}”` : "What can we help you find?"}
          </h2>
          <span className="muted">Matched by Locogi · never client-ranked</span>
        </div>
        <LoadState {...result} retry={result.refresh} />
        {!query ? (
          <Empty title="Your neighborhood is full of possibilities.">
            <p>Choose a category or search in your own words to get started.</p>
          </Empty>
        ) : !result.loading && !result.error && !ids.length ? (
          <Empty title="No businesses to show for this search.">
            <p>Try another service or include your neighborhood.</p>
          </Empty>
        ) : (
          <div className="business-grid">
            {ids.map((id) => (
              <BusinessCard orgId={id} key={id} />
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
