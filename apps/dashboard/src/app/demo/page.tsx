'use client'

import { useState, useEffect, useRef } from 'react'

// ─── Demo conversation scripts ──────────────────────────────────────────────

interface ChatMsg {
  role: 'user' | 'agent'
  text: string
  ui?: 'catalog' | 'resources' | 'slots' | 'cart' | 'confirmation'
  delay: number // ms before this message appears
}

const DEMO_SCRIPTS: Record<string, ChatMsg[]> = {
  photographer: [
    { role: 'user', text: 'I need a wedding photographer in Hyderabad', delay: 0 },
    { role: 'agent', text: '📸 I found 2 photography studios near you!', delay: 1200, ui: 'catalog' },
    { role: 'user', text: 'Show me Anikanth Studio packages', delay: 2500 },
    { role: 'agent', text: 'Here are the packages from Anikanth Studio:', delay: 1500, ui: 'resources' },
    { role: 'user', text: 'Add Wedding Photography Full Day to cart', delay: 2000 },
    { role: 'agent', text: '✅ Added to cart! Here\'s your cart:', delay: 1000, ui: 'cart' },
    { role: 'user', text: 'Book for September 20th', delay: 2000 },
    { role: 'agent', text: '📅 Available slots for Sep 20:', delay: 1200, ui: 'slots' },
    { role: 'user', text: 'Morning slot, my number is 9876543210', delay: 2000 },
    { role: 'agent', text: '🎉 Booking confirmed!', delay: 1500, ui: 'confirmation' },
  ],
  restaurant: [
    { role: 'user', text: 'Order biryani from Paradise for 7pm delivery', delay: 0 },
    { role: 'agent', text: '🍛 Here\'s Paradise Restaurant\'s menu:', delay: 1200, ui: 'catalog' },
    { role: 'user', text: 'Add 2 chicken biryani and 1 raita', delay: 2500 },
    { role: 'agent', text: '✅ Added! Your cart:', delay: 1000, ui: 'cart' },
    { role: 'user', text: 'Apply promo LUNCH20', delay: 1800 },
    { role: 'agent', text: '🎟️ LUNCH20 applied! 20% off. New total: ₹680', delay: 1200 },
    { role: 'user', text: 'Place order, my number is 9876543210', delay: 2000 },
    { role: 'agent', text: '🎉 Order placed! Delivery at 7:00 PM', delay: 1500, ui: 'confirmation' },
  ],
  salon: [
    { role: 'user', text: 'Haircut + facial at 11am tomorrow', delay: 0 },
    { role: 'agent', text: '💇 Found StyleHub Salon! Here are services:', delay: 1200, ui: 'catalog' },
    { role: 'user', text: 'Both please — haircut and facial', delay: 2500 },
    { role: 'agent', text: '✅ Added! Available stylists:', delay: 1000, ui: 'resources' },
    { role: 'user', text: 'Rahul for haircut, Meena for facial', delay: 2000 },
    { role: 'agent', text: '📅 Both free at 11 AM tomorrow!', delay: 1200, ui: 'slots' },
    { role: 'user', text: 'Confirm, my number is 9876543210', delay: 2000 },
    { role: 'agent', text: '🎉 Booked! Haircut + Facial at 11 AM', delay: 1500, ui: 'confirmation' },
  ],
}

// ─── UI component renderers ─────────────────────────────────────────────────

const MOCK_DATA: Record<string, Record<string, any>> = {
  photographer: {
    catalog: [
      { name: 'Anikanth Studio', rating: '⭐ 4.8', area: 'Jubilee Hills', price: '₹8,000+', img: '📸' },
      { name: 'PixelPerfect Studio', rating: '⭐ 4.6', area: 'Banjara Hills', price: '₹12,000+', img: '📷' },
    ],
    resources: [
      { name: 'Wedding Photography — Full Day', price: '₹25,000', desc: '8hrs coverage, 500+ photos' },
      { name: 'Pre-Wedding Shoot', price: '₹8,000', desc: '3 locations, 100+ photos' },
      { name: 'Baby Milestone Shoot', price: '₹4,500', desc: '1hr session, 50+ photos' },
    ],
    cart: [{ name: 'Wedding Photography — Full Day', qty: 1, price: '₹25,000' }],
    slots: ['9:00 AM — Morning', '2:00 PM — Afternoon', '5:00 PM — Golden Hour'],
    confirmation: { service: 'Wedding Photography — Full Day', business: 'Anikanth Studio', date: 'Sep 20, 2026', time: '9:00 AM', total: '₹25,000' },
  },
  restaurant: {
    catalog: [
      { name: 'Chicken Biryani', price: '₹350', desc: 'Dum cooked, serves 1' },
      { name: 'Mutton Biryani', price: '₹450', desc: 'Dum cooked, serves 1' },
      { name: 'Raita', price: '₹50', desc: 'Fresh yogurt side' },
      { name: 'Gulab Jamun (2pc)', price: '₹80', desc: 'Classic dessert' },
    ],
    cart: [
      { name: 'Chicken Biryani', qty: 2, price: '₹700' },
      { name: 'Raita', qty: 1, price: '₹50' },
    ],
    confirmation: { service: '2× Chicken Biryani + 1× Raita', business: 'Paradise Restaurant', date: 'Today', time: '7:00 PM Delivery', total: '₹680 (after LUNCH20)' },
  },
  salon: {
    catalog: [
      { name: 'Haircut — Men', price: '₹300', desc: '30 min' },
      { name: 'Facial — Classic', price: '₹800', desc: '45 min' },
      { name: 'Hair Spa', price: '₹1,200', desc: '60 min' },
    ],
    resources: [
      { name: 'Rahul', price: 'Haircut Specialist', desc: '⭐ 4.9 · 500+ cuts' },
      { name: 'Meena', price: 'Facial Expert', desc: '⭐ 4.8 · 300+ sessions' },
    ],
    slots: ['10:00 AM', '11:00 AM ✓', '12:00 PM', '2:00 PM'],
    cart: [
      { name: 'Haircut — Men (Rahul)', qty: 1, price: '₹300' },
      { name: 'Facial — Classic (Meena)', qty: 1, price: '₹800' },
    ],
    confirmation: { service: 'Haircut + Facial', business: 'StyleHub Salon', date: 'Tomorrow', time: '11:00 AM', total: '₹1,100' },
  },
}

function UIComponent({ type, scenario }: { type: string; scenario: string }) {
  const data = MOCK_DATA[scenario]?.[type]
  if (!data) return null

  if (type === 'catalog' && Array.isArray(data)) {
    return (
      <div className="demo-ui-grid">
        {data.map((item: any, i: number) => (
          <div key={i} className="demo-ui-card">
            <div className="demo-ui-card-icon">{item.img ?? '📦'}</div>
            <div className="demo-ui-card-body">
              <div className="demo-ui-card-name">{item.name}</div>
              {item.rating && <div className="demo-ui-card-meta">{item.rating} · {item.area}</div>}
              {item.desc && <div className="demo-ui-card-meta">{item.desc}</div>}
              <div className="demo-ui-card-price">{item.price}</div>
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (type === 'resources' && Array.isArray(data)) {
    return (
      <div className="demo-ui-list">
        {data.map((r: any, i: number) => (
          <div key={i} className="demo-ui-list-item">
            <div className="demo-ui-list-name">{r.name}</div>
            <div className="demo-ui-list-meta">{r.desc}</div>
            <div className="demo-ui-list-price">{r.price}</div>
          </div>
        ))}
      </div>
    )
  }

  if (type === 'cart' && Array.isArray(data)) {
    const total = data.reduce((s: number, i: any) => s + parseInt(i.price.replace(/[₹,]/g, '')) * i.qty, 0)
    return (
      <div className="demo-ui-cart">
        {data.map((item: any, i: number) => (
          <div key={i} className="demo-ui-cart-item">
            <span>{item.name} × {item.qty}</span>
            <span>{item.price}</span>
          </div>
        ))}
        <div className="demo-ui-cart-total">
          <span>Total</span>
          <span>₹{total.toLocaleString()}</span>
        </div>
      </div>
    )
  }

  if (type === 'slots' && Array.isArray(data)) {
    return (
      <div className="demo-ui-slots">
        {data.map((slot: string, i: number) => (
          <button key={i} className={`demo-ui-slot ${slot.includes('✓') || i === 0 ? 'active' : ''}`}>
            {slot}
          </button>
        ))}
      </div>
    )
  }

  if (type === 'confirmation' && data) {
    return (
      <div className="demo-ui-confirm">
        <div className="demo-ui-confirm-icon">✅</div>
        <div className="demo-ui-confirm-title">Booking Confirmed!</div>
        <div className="demo-ui-confirm-detail"><span>Service</span><span>{data.service}</span></div>
        <div className="demo-ui-confirm-detail"><span>Business</span><span>{data.business}</span></div>
        <div className="demo-ui-confirm-detail"><span>Date</span><span>{data.date}</span></div>
        <div className="demo-ui-confirm-detail"><span>Time</span><span>{data.time}</span></div>
        <div className="demo-ui-confirm-total"><span>Total</span><span>{data.total}</span></div>
      </div>
    )
  }

  return null
}

// ─── Main Demo Page ─────────────────────────────────────────────────────────

export default function DemoPage() {
  const [scenario, setScenario] = useState<string>('photographer')
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [isPlaying, setIsPlaying] = useState(false)
  const [msgIndex, setMsgIndex] = useState(0)
  const chatRef = useRef<HTMLDivElement>(null)

  const script = DEMO_SCRIPTS[scenario]

  // Auto-scroll chat
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight
    }
  }, [messages])

  // Play demo
  useEffect(() => {
    if (!isPlaying || msgIndex >= script.length) {
      if (msgIndex >= script.length) setIsPlaying(false)
      return
    }

    const msg = script[msgIndex]
    const timer = setTimeout(() => {
      setMessages(prev => [...prev, msg])
      setMsgIndex(prev => prev + 1)
    }, msg.delay + (msg.role === 'agent' ? 800 : 400))

    return () => clearTimeout(timer)
  }, [isPlaying, msgIndex, script])

  const startDemo = () => {
    setMessages([])
    setMsgIndex(0)
    setIsPlaying(true)
  }

  const switchScenario = (s: string) => {
    setScenario(s)
    setMessages([])
    setMsgIndex(0)
    setIsPlaying(false)
  }

  return (
    <div className="demo-page">
      {/* Hero */}
      <section className="demo-hero">
        <div className="demo-hero-badge">🚀 Live Demo</div>
        <h1 className="demo-hero-title">
          ChatGPT for <span className="demo-gradient-text">Local Services</span>
        </h1>
        <p className="demo-hero-subtitle">
          One conversation. Full transaction. Every local business gets its own AI agent.
        </p>
      </section>

      {/* Scenario Switcher */}
      <section className="demo-scenarios">
        {[
          { id: 'photographer', icon: '📸', label: 'Book Photographer' },
          { id: 'restaurant', icon: '🍛', label: 'Order Food' },
          { id: 'salon', icon: '💇', label: 'Book Salon' },
        ].map(s => (
          <button
            key={s.id}
            className={`demo-scenario-btn ${scenario === s.id ? 'active' : ''}`}
            onClick={() => switchScenario(s.id)}
          >
            <span className="demo-scenario-icon">{s.icon}</span>
            <span>{s.label}</span>
          </button>
        ))}
      </section>

      {/* Chat Demo */}
      <section className="demo-chat-container">
        <div className="demo-phone">
          {/* Phone Header */}
          <div className="demo-phone-header">
            <div className="demo-phone-notch" />
            <div className="demo-phone-status">
              <span>Locogi</span>
              <span className="demo-phone-dot" />
              <span style={{ fontSize: 11, color: '#10b981' }}>Online</span>
            </div>
          </div>

          {/* Chat Messages */}
          <div className="demo-chat-messages" ref={chatRef}>
            {messages.length === 0 && (
              <div className="demo-chat-empty">
                <div style={{ fontSize: 48, marginBottom: 12 }}>💬</div>
                <div>Click <strong>Play Demo</strong> to watch the AI agent in action</div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`demo-msg demo-msg-${msg.role}`}>
                <div className={`demo-msg-bubble demo-msg-bubble-${msg.role}`}>
                  {msg.text}
                </div>
                {msg.ui && <UIComponent type={msg.ui} scenario={scenario} />}
              </div>
            ))}

            {isPlaying && msgIndex < script.length && (
              <div className="demo-msg demo-msg-agent">
                <div className="demo-typing">
                  <span /><span /><span />
                </div>
              </div>
            )}
          </div>

          {/* Chat Input */}
          <div className="demo-chat-input">
            <input
              type="text"
              placeholder="Type a message..."
              disabled
            />
            <button className="demo-send-btn" disabled>➤</button>
          </div>
        </div>

        {/* Controls */}
        <div className="demo-controls">
          <button
            className="demo-play-btn"
            onClick={startDemo}
            disabled={isPlaying}
          >
            {isPlaying ? '⏳ Playing...' : messages.length > 0 ? '🔄 Replay' : '▶ Play Demo'}
          </button>
          <p className="demo-controls-hint">
            Watch the AI agent handle a complete {scenario === 'photographer' ? 'photography booking' : scenario === 'restaurant' ? 'food order' : 'salon appointment'} — from discovery to confirmation.
          </p>

          {/* Feature callouts */}
          <div className="demo-features">
            <div className="demo-feature">
              <div className="demo-feature-icon">🧠</div>
              <div>
                <div className="demo-feature-title">AI-Powered</div>
                <div className="demo-feature-desc">GPT-4.1 understands natural language requests</div>
              </div>
            </div>
            <div className="demo-feature">
              <div className="demo-feature-icon">⚡</div>
              <div>
                <div className="demo-feature-title">&lt;10ms Discovery</div>
                <div className="demo-feature-desc">Moss semantic search finds businesses instantly</div>
              </div>
            </div>
            <div className="demo-feature">
              <div className="demo-feature-icon">🔒</div>
              <div>
                <div className="demo-feature-title">Real Transactions</div>
                <div className="demo-feature-desc">Not a demo — actual cart, booking, confirmation</div>
              </div>
            </div>
            <div className="demo-feature">
              <div className="demo-feature-icon">💰</div>
              <div>
                <div className="demo-feature-title">0% Commission</div>
                <div className="demo-feature-desc">Business keeps 100% of every transaction</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="demo-how-it-works">
        <h2>How It Works</h2>
        <div className="demo-steps">
          <div className="demo-step">
            <div className="demo-step-num">1</div>
            <div className="demo-step-title">Ask</div>
            <div className="demo-step-desc">Tell the agent what you need in plain language</div>
          </div>
          <div className="demo-step-arrow">→</div>
          <div className="demo-step">
            <div className="demo-step-num">2</div>
            <div className="demo-step-title">Browse</div>
            <div className="demo-step-desc">AI shows matching businesses, packages, and availability</div>
          </div>
          <div className="demo-step-arrow">→</div>
          <div className="demo-step">
            <div className="demo-step-num">3</div>
            <div className="demo-step-title">Book</div>
            <div className="demo-step-desc">Pick your slot, confirm, done. No app download needed.</div>
          </div>
        </div>
      </section>

      {/* Try Live */}
      <section className="demo-cta">
        <h2>Try It Live</h2>
        <p>The bot is live on Telegram right now. Send it a message.</p>
        <a
          href="https://t.me/locogi_bot"
          target="_blank"
          rel="noopener noreferrer"
          className="demo-cta-btn"
        >
          💬 Open @locogi_bot on Telegram
        </a>
      </section>
    </div>
  )
}
