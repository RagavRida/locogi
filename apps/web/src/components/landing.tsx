"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { categories, Icon, PageShell } from "./ui";

function ConversationPreview() {
  const [step, setStep] = useState(0);
  const [scenario, setScenario] = useState(0);
  const scenarios = [
    {
      label: "Photographer",
      icon: "camera",
      question: "I need a photographer for our big day. 📸",
      answer:
        "Let’s make it memorable. Tell me your date and the kind of moments you want to capture.",
      title: "A day worth remembering.",
      subtitle: "PHOTOGRAPHY · EXAMPLE",
      reply: "Can we check Saturday?",
      art: "THE BIG",
      detail: "little moments.",
    },
    {
      label: "Restaurant",
      icon: "food",
      question: "Something delicious for dinner tonight? 🍛",
      answer:
        "Let’s find your next favorite. Browse the menu, choose your dishes, and review your order.",
      title: "Good food. Great company.",
      subtitle: "RESTAURANT · EXAMPLE",
      reply: "I’d like biryani for two.",
      art: "A LITTLE",
      detail: "taste of home.",
    },
    {
      label: "Salon",
      icon: "scissors",
      question: "I’d love a haircut this weekend. 💇",
      answer:
        "A little you-time sounds good. Choose a service and stylist, then ask about available appointments.",
      title: "Your next fresh start.",
      subtitle: "SALON · EXAMPLE",
      reply: "Is Saturday morning available?",
      art: "A FRESH",
      detail: "kind of feeling.",
    },
  ];
  const demo = scenarios[scenario];
  useEffect(() => {
    const timer = setInterval(
      () => setStep((current) => (current + 1) % 4),
      3400,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="hero-visual">
      <div className="demo-tabs" role="group" aria-label="Demo scenarios">
        {scenarios.map((item, index) => (
          <button
            key={item.label}
            aria-pressed={scenario === index}
            onClick={() => {
              setScenario(index);
              setStep(0);
            }}
          >
            <Icon name={item.icon} size={14} />
            {item.label}
          </button>
        ))}
      </div>
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <span className="floating-icon float-camera">
        <Icon name="camera" size={26} />
      </span>
      <span className="floating-icon float-food">
        <Icon name="food" size={23} />
      </span>
      <div className="preview-window">
        <div className="preview-title">
          <div className="agent-avatar">l.</div>
          <div>
            <strong>Your local, on call.</strong>
            <span>
              <i className="dot live" /> Locogi agent · Illustrative demo
            </span>
          </div>
          <span className="sparkle">✧</span>
        </div>
        <div className="preview-body">
          <div className="preview-bubble user-preview">{demo.question}</div>
          <div className="preview-bubble agent-preview">{demo.answer}</div>
          <div className={`preview-detail ${step > 0 ? "visible" : ""}`}>
            <div className="photo-art">
              <span>
                {demo.art}
                <br />
                <em>{demo.detail}</em>
              </span>
              <div className="camera-outline">
                <Icon name={demo.icon} size={48} />
              </div>
            </div>
            <div className="preview-service">
              <span className="mini-label">{demo.subtitle}</span>
              <strong>{demo.title}</strong>
              <span>
                Explore packages with a business agent{" "}
                <Icon name="arrow" size={14} />
              </span>
            </div>
          </div>
          <div
            className={`preview-bubble user-preview demo-reply ${step > 1 ? "visible" : ""}`}
          >
            {demo.reply}
          </div>
          <div className={`preview-safe ${step > 2 ? "visible" : ""}`}>
            <Icon name="shield" size={16} /> You review the details before
            anything is booked.
          </div>
        </div>
        <div className="preview-composer">
          <span>Just ask. We’ll take it from here.</span>
          <span>↑</span>
        </div>
      </div>
      <div className="visual-caption">
        <span className="tiny-spark">✦</span> Less searching. More living.
      </div>
    </div>
  );
}
export default function Landing() {
  return (
    <PageShell>
      <div id="content">
        <section className="hero page-container">
          <div className="hero-copy">
            <span className="eyebrow pill">
              <span className="dot live" /> YOUR NEIGHBORHOOD. ONE CONVERSATION.
            </span>
            <h1>
              ChatGPT for
              <br />
              local services.
              <br />
              <span className="hero-accent">Ask. Book. Done.</span>
            </h1>
            <p className="hero-description">
              A table for two. A fresh new look. Someone to capture your big
              day. Just tell us what you need.
            </p>
            <div className="hero-buttons">
              <a
                className="button secondary large"
                href="https://t.me/locogi_bot"
                target="_blank"
                rel="noopener noreferrer"
              >
                Try on Telegram ↗
              </a>
              <Link className="button primary large" href="/chat">
                Find your something <Icon name="arrow" />
              </Link>
              <Link className="button ghost large" href="/services">
                <Icon name="grid" size={17} /> Explore services
              </Link>
            </div>
            <div className="hero-fineprint">
              <span>
                <Icon name="check" size={15} /> No endless scrolling
              </span>
              <span>
                <Icon name="check" size={15} /> No phone tag
              </span>
              <span>
                <Icon name="check" size={15} /> Just a conversation
              </span>
            </div>
          </div>
          <ConversationPreview />
        </section>
        <div className="promise-strip">
          <span>LOCAL KNOW-HOW.</span>
          <span>REAL BUSINESSES.</span>
          <span>A LITTLE AI MAGIC.</span>
          <span>ALL IN ONE PLACE.</span>
        </div>
        <section className="section page-container">
          <div className="section-heading">
            <div>
              <p className="eyebrow">A WORLD AROUND THE CORNER</p>
              <h2>What’s on your mind?</h2>
            </div>
            <Link className="inline-link" href="/services">
              Explore all services <Icon name="arrow" size={18} />
            </Link>
          </div>
          <div className="category-grid">
            {categories.map((category) => (
              <Link
                className={`category-card ${category.tone}`}
                href={`/services?q=${category.query}`}
                key={category.name}
              >
                <span className="category-icon">
                  <Icon name={category.icon} size={29} />
                </span>
                <h3>{category.name}</h3>
                <p>{category.note}</p>
                <span className="category-arrow">↗</span>
              </Link>
            ))}
          </div>
        </section>
        <section
          className="section how-section page-container"
          id="how-it-works"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">FROM “I NEED” TO “ALL SET”</p>
              <h2>
                Life’s complicated.
                <br />
                Booking shouldn’t be.
              </h2>
            </div>
            <p className="section-description">
              Skip the tabs, the calls, and the back-and-forth.
              <br />
              Your next great local experience starts here.
            </p>
          </div>
          <div className="steps-grid">
            {[
              {
                title: "Say what you need.",
                body: "“A wedding photographer in Hyderabad.” Search like you talk. We’ll help you explore.",
                icon: "search",
              },
              {
                title: "Meet your local expert.",
                body: "Chat with the business’s own AI agent. Ask about services, availability, and the little details.",
                icon: "chat",
              },
              {
                title: "Make it happen.",
                body: "Pick your service and time. Review the details, confirm, and get back to your day.",
                icon: "calendar",
              },
            ].map((step, index) => (
              <article className="step-card" key={step.title}>
                <div>
                  <span className="step-number">0{index + 1}</span>
                  <Icon name={step.icon} size={27} />
                </div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="page-container business-callout">
          <div className="business-art">
            <div className="art-ring" />
            <span className="art-spark">✳</span>
            <span className="art-label">
              YOUR BUSINESS.
              <br />
              ALWAYS IN THE CONVERSATION.
            </span>
          </div>
          <div>
            <p className="eyebrow">FOR THE PEOPLE BEHIND THE BUSINESS</p>
            <h2>
              You do what you love.
              <br />
              <span className="muted">Your agent handles the rest.</span>
            </h2>
            <p>
              Give your business an AI front desk that knows your services.
              Manage your catalog, your people, and your bookings in one
              workspace.
            </p>
            <Link className="button primary" href="/onboard">
              Set up your business with AI <Icon name="arrow" />
            </Link>
          </div>
        </section>
        <section className="page-container section feedback-section">
          <p className="eyebrow">BUILT FOR REAL CONNECTIONS</p>
          <h2>
            The next good story
            <br />
            starts in your neighborhood.
          </h2>
          <p>
            We’re making room for customer stories. Verified testimonials will
            appear here as the community grows.
          </p>
          <Link className="inline-link" href="/chat">
            Start your own conversation <Icon name="arrow" />
          </Link>
        </section>
      </div>
    </PageShell>
  );
}
