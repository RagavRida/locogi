/**
 * Locogi Embeddable Booking Widget
 *
 * Usage:
 *   <script src="https://widget.locogi.com/v1.js"
 *           data-org-id="uuid-here"
 *           data-api-url="https://api.locogi.com"
 *           data-theme="dark">
 *   </script>
 *
 * Or programmatic:
 *   LocogiWidget.init({ orgId: '...', apiUrl: '...' })
 *
 * The widget renders as a floating button → modal booking flow.
 * It injects its own shadow DOM so it cannot conflict with the host site's CSS.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface WidgetConfig {
  orgId: string
  apiUrl: string
  theme?: 'light' | 'dark' | 'auto'
  position?: 'bottom-right' | 'bottom-left'
  primaryColor?: string
  buttonText?: string
}

interface OrgConfig {
  orgId: string
  name: string
  type: string
  bookingTypes: string[]
  branding: Record<string, any>
  address: string | null
  area: string | null
  phone: string | null
}

interface CatalogItem {
  id: string
  name: string
  description: string | null
  price: number
  currency: string
  isVeg: boolean | null
  section: string
}

interface Resource {
  id: string
  name: string
  resource_type: string
  specialization: string | null
  price_per_slot: number | null
  consultation_duration_minutes: number | null
}

interface Slot {
  id: string
  time: string
  duration: number
  available: number
  price: number | null
}

interface CartItem {
  item: CatalogItem
  quantity: number
  notes: string
}

// ─── State ──────────────────────────────────────────────────────────────────

let config: WidgetConfig
let orgConfig: OrgConfig | null = null
let state: 'closed' | 'loading' | 'menu' | 'catalog' | 'resources' | 'slots' | 'cart' | 'checkout' | 'success' | 'error' = 'closed'
let cart: CartItem[] = []
let selectedResource: Resource | null = null
let selectedSlot: Slot | null = null
let shadow: ShadowRoot
let container: HTMLDivElement

// ─── API helpers ────────────────────────────────────────────────────────────

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${config.apiUrl}/api/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

// ─── Styles ─────────────────────────────────────────────────────────────────

function getStyles(theme: 'light' | 'dark', primaryColor: string): string {
  const isDark = theme === 'dark'
  const bg = isDark ? '#1a1a2e' : '#ffffff'
  const bgCard = isDark ? '#16213e' : '#f8f9fa'
  const text = isDark ? '#e4e4e7' : '#1a1a2e'
  const textMuted = isDark ? '#a1a1aa' : '#71717a'
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
  const glass = isDark ? 'rgba(22,33,62,0.85)' : 'rgba(255,255,255,0.92)'

  return `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

    :host { all: initial; font-family: 'Inter', system-ui, sans-serif; }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    .locogi-fab {
      position: fixed; bottom: 24px; right: 24px; z-index: 99999;
      width: 60px; height: 60px; border-radius: 50%;
      background: linear-gradient(135deg, ${primaryColor}, ${primaryColor}dd);
      color: white; border: none; cursor: pointer;
      box-shadow: 0 4px 20px ${primaryColor}44;
      display: flex; align-items: center; justify-content: center;
      font-size: 24px; transition: all 0.3s cubic-bezier(0.4,0,0.2,1);
    }
    .locogi-fab:hover { transform: scale(1.1); box-shadow: 0 6px 28px ${primaryColor}66; }
    .locogi-fab.left { right: auto; left: 24px; }

    .locogi-modal {
      position: fixed; bottom: 100px; right: 24px; z-index: 99998;
      width: 400px; max-width: calc(100vw - 32px); max-height: 600px;
      background: ${glass}; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      border-radius: 20px; border: 1px solid ${border};
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      display: flex; flex-direction: column; overflow: hidden;
      animation: slideUp 0.35s cubic-bezier(0.4,0,0.2,1);
    }
    .locogi-modal.left { right: auto; left: 24px; }
    .locogi-modal.hidden { display: none; }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .modal-header {
      padding: 20px 20px 16px;
      border-bottom: 1px solid ${border};
      display: flex; align-items: center; justify-content: space-between;
    }
    .modal-header h3 {
      font-size: 17px; font-weight: 700; color: ${text}; letter-spacing: -0.3px;
    }
    .modal-header .badge {
      font-size: 11px; font-weight: 600; padding: 3px 10px;
      border-radius: 100px; background: ${primaryColor}18; color: ${primaryColor};
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .close-btn {
      width: 32px; height: 32px; border-radius: 50%;
      background: ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'};
      border: none; cursor: pointer; color: ${textMuted};
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; transition: background 0.2s;
    }
    .close-btn:hover { background: ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'}; }

    .modal-body {
      flex: 1; overflow-y: auto; padding: 16px 20px;
      scrollbar-width: thin; scrollbar-color: ${border} transparent;
    }

    .menu-item {
      padding: 14px 16px; border-radius: 14px;
      background: ${bgCard}; border: 1px solid ${border};
      margin-bottom: 10px; cursor: pointer;
      transition: all 0.2s; display: flex; align-items: center; gap: 14px;
    }
    .menu-item:hover {
      border-color: ${primaryColor}44; background: ${primaryColor}08;
      transform: translateX(4px);
    }
    .menu-icon {
      width: 44px; height: 44px; border-radius: 12px;
      background: ${primaryColor}14; color: ${primaryColor};
      display: flex; align-items: center; justify-content: center;
      font-size: 20px; flex-shrink: 0;
    }
    .menu-text h4 { font-size: 14px; font-weight: 600; color: ${text}; margin-bottom: 2px; }
    .menu-text p { font-size: 12px; color: ${textMuted}; }

    .section-title {
      font-size: 11px; font-weight: 700; color: ${textMuted};
      text-transform: uppercase; letter-spacing: 1px;
      margin: 16px 0 10px; padding-left: 2px;
    }

    .catalog-item {
      padding: 12px 14px; border-radius: 12px;
      background: ${bgCard}; border: 1px solid ${border};
      margin-bottom: 8px; display: flex; justify-content: space-between;
      align-items: center; transition: all 0.2s;
    }
    .catalog-item:hover { border-color: ${primaryColor}33; }
    .item-info h4 { font-size: 13px; font-weight: 600; color: ${text}; }
    .item-info p { font-size: 11px; color: ${textMuted}; margin-top: 2px; }
    .item-price { font-size: 14px; font-weight: 700; color: ${primaryColor}; white-space: nowrap; }
    .veg-badge {
      display: inline-block; width: 14px; height: 14px; border: 1.5px solid #22c55e;
      border-radius: 3px; position: relative; margin-right: 6px; vertical-align: middle;
    }
    .veg-badge::after {
      content: ''; position: absolute; top: 50%; left: 50%;
      transform: translate(-50%,-50%); width: 6px; height: 6px;
      background: #22c55e; border-radius: 50%;
    }
    .nonveg-badge { border-color: #ef4444; }
    .nonveg-badge::after { background: #ef4444; }

    .add-btn {
      padding: 6px 14px; border-radius: 8px; border: 1px solid ${primaryColor}44;
      background: ${primaryColor}0a; color: ${primaryColor};
      font-size: 12px; font-weight: 600; cursor: pointer;
      transition: all 0.2s; white-space: nowrap;
    }
    .add-btn:hover { background: ${primaryColor}; color: white; }

    .resource-card {
      padding: 14px; border-radius: 14px;
      background: ${bgCard}; border: 1px solid ${border};
      margin-bottom: 10px; cursor: pointer; transition: all 0.2s;
    }
    .resource-card:hover { border-color: ${primaryColor}44; transform: translateY(-2px); }
    .resource-card.selected { border-color: ${primaryColor}; background: ${primaryColor}0a; }
    .resource-card h4 { font-size: 14px; font-weight: 600; color: ${text}; }
    .resource-card p { font-size: 12px; color: ${textMuted}; margin-top: 4px; }
    .resource-card .price { font-size: 13px; font-weight: 700; color: ${primaryColor}; margin-top: 6px; }

    .slot-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;
    }
    .slot-btn {
      padding: 10px 8px; border-radius: 10px; border: 1px solid ${border};
      background: ${bgCard}; color: ${text};
      font-size: 12px; font-weight: 500; cursor: pointer; text-align: center;
      transition: all 0.2s;
    }
    .slot-btn:hover { border-color: ${primaryColor}66; }
    .slot-btn.selected { background: ${primaryColor}; color: white; border-color: ${primaryColor}; }
    .slot-date { font-size: 12px; font-weight: 700; color: ${text}; margin: 12px 0 8px; }

    .cart-summary {
      padding: 14px; border-radius: 14px;
      background: ${bgCard}; border: 1px solid ${border};
      margin-bottom: 10px;
    }
    .cart-item {
      display: flex; justify-content: space-between; align-items: center;
      padding: 6px 0; font-size: 13px; color: ${text};
    }
    .cart-total {
      display: flex; justify-content: space-between;
      padding-top: 10px; margin-top: 10px;
      border-top: 1px solid ${border};
      font-size: 15px; font-weight: 700; color: ${text};
    }

    .form-group { margin-bottom: 14px; }
    .form-group label {
      display: block; font-size: 12px; font-weight: 600;
      color: ${textMuted}; margin-bottom: 6px;
    }
    .form-input {
      width: 100%; padding: 10px 14px; border-radius: 10px;
      border: 1px solid ${border}; background: ${bgCard};
      color: ${text}; font-size: 14px; font-family: 'Inter', system-ui;
      transition: border-color 0.2s;
    }
    .form-input:focus { outline: none; border-color: ${primaryColor}; }

    .primary-btn {
      width: 100%; padding: 14px; border-radius: 14px;
      background: linear-gradient(135deg, ${primaryColor}, ${primaryColor}dd);
      color: white; border: none; cursor: pointer;
      font-size: 15px; font-weight: 600; font-family: 'Inter', system-ui;
      transition: all 0.2s; box-shadow: 0 4px 16px ${primaryColor}33;
    }
    .primary-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 20px ${primaryColor}44; }
    .primary-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

    .back-btn {
      background: none; border: none; cursor: pointer;
      color: ${textMuted}; font-size: 13px; font-weight: 500;
      padding: 0; margin-bottom: 12px; display: flex; align-items: center; gap: 4px;
    }
    .back-btn:hover { color: ${text}; }

    .success-view {
      text-align: center; padding: 40px 20px;
    }
    .success-icon {
      width: 64px; height: 64px; border-radius: 50%;
      background: #22c55e18; color: #22c55e;
      display: flex; align-items: center; justify-content: center;
      font-size: 32px; margin: 0 auto 16px;
    }
    .success-view h3 { font-size: 18px; font-weight: 700; color: ${text}; margin-bottom: 8px; }
    .success-view p { font-size: 13px; color: ${textMuted}; line-height: 1.5; }

    .loading { text-align: center; padding: 40px; color: ${textMuted}; }
    .spinner {
      width: 32px; height: 32px; border: 3px solid ${border};
      border-top-color: ${primaryColor}; border-radius: 50%;
      animation: spin 0.8s linear infinite; margin: 0 auto 12px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .modal-footer {
      padding: 14px 20px; border-top: 1px solid ${border};
    }

    @media (max-width: 480px) {
      .locogi-modal {
        width: 100%; bottom: 0; right: 0; left: 0;
        max-height: 85vh; border-radius: 20px 20px 0 0;
      }
      .locogi-fab { bottom: 16px; right: 16px; }
    }
  `
}

// ─── Render helpers ─────────────────────────────────────────────────────────

function render() {
  if (!shadow || !container) return
  const body = container.querySelector('.modal-body')
  const footer = container.querySelector('.modal-footer')
  if (!body || !footer) return

  switch (state) {
    case 'loading':
      body.innerHTML = `<div class="loading"><div class="spinner"></div><p>Loading...</p></div>`
      footer.innerHTML = ''
      break

    case 'menu':
      renderMenu(body, footer)
      break

    case 'catalog':
      renderCatalog(body, footer)
      break

    case 'resources':
      renderResources(body, footer)
      break

    case 'slots':
      renderSlots(body, footer)
      break

    case 'cart':
      renderCart(body, footer)
      break

    case 'checkout':
      renderCheckout(body, footer)
      break

    case 'success':
      renderSuccess(body, footer)
      break

    case 'error':
      body.innerHTML = `<div class="loading"><p>Something went wrong. Please try again.</p></div>`
      footer.innerHTML = `<button class="primary-btn" id="lok-retry">Try Again</button>`
      footer.querySelector('#lok-retry')?.addEventListener('click', () => {
        state = 'loading'
        render()
        loadOrgConfig()
      })
      break
  }
}

function renderMenu(body: Element, footer: Element) {
  if (!orgConfig) return

  const items: { icon: string; title: string; desc: string; action: string }[] = []

  if (orgConfig.bookingTypes.includes('order')) {
    items.push({ icon: '🍽️', title: 'Order Now', desc: 'Browse menu & place an order', action: 'catalog' })
  }
  if (orgConfig.bookingTypes.includes('appointment')) {
    items.push({ icon: '📅', title: 'Book Appointment', desc: 'Choose a time slot', action: 'resources' })
  }
  if (orgConfig.bookingTypes.includes('quote')) {
    items.push({ icon: '💬', title: 'Get a Quote', desc: 'Describe what you need', action: 'checkout' })
  }
  if (orgConfig.bookingTypes.includes('hiring')) {
    items.push({ icon: '👤', title: 'Hire a Professional', desc: 'Find the right person', action: 'checkout' })
  }

  body.innerHTML = items.map(i => `
    <div class="menu-item" data-action="${i.action}">
      <div class="menu-icon">${i.icon}</div>
      <div class="menu-text">
        <h4>${i.title}</h4>
        <p>${i.desc}</p>
      </div>
    </div>
  `).join('')

  footer.innerHTML = ''

  body.querySelectorAll('.menu-item').forEach(el => {
    el.addEventListener('click', () => {
      const action = el.getAttribute('data-action') as any
      state = action
      render()
      if (action === 'catalog') loadCatalog()
      if (action === 'resources') loadResources()
    })
  })
}

async function loadCatalog() {
  try {
    const data = await api<{ sections: Record<string, CatalogItem[]> }>(
      `/widget/catalog/${config.orgId}`
    )
    renderCatalogItems(data.sections)
  } catch {
    state = 'error'
    render()
  }
}

function renderCatalog(body: Element, footer: Element) {
  body.innerHTML = `
    <button class="back-btn" id="lok-back">← Back</button>
    <div class="loading"><div class="spinner"></div><p>Loading menu...</p></div>
  `
  footer.innerHTML = cart.length > 0
    ? `<button class="primary-btn" id="lok-view-cart">View Cart (${cart.reduce((s,i) => s + i.quantity, 0)} items)</button>`
    : ''

  body.querySelector('#lok-back')?.addEventListener('click', () => { state = 'menu'; render() })
  footer.querySelector('#lok-view-cart')?.addEventListener('click', () => { state = 'cart'; render() })
}

function renderCatalogItems(sections: Record<string, CatalogItem[]>) {
  const body = container.querySelector('.modal-body')
  if (!body) return

  let html = `<button class="back-btn" id="lok-back">← Back</button>`

  for (const [section, items] of Object.entries(sections)) {
    html += `<div class="section-title">${section}</div>`
    for (const item of items) {
      const vegBadge = item.isVeg !== null
        ? `<span class="veg-badge ${item.isVeg ? '' : 'nonveg-badge'}"></span>`
        : ''
      html += `
        <div class="catalog-item">
          <div class="item-info">
            <h4>${vegBadge}${item.name}</h4>
            ${item.description ? `<p>${item.description}</p>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="item-price">₹${item.price}</span>
            <button class="add-btn" data-id="${item.id}">Add</button>
          </div>
        </div>
      `
    }
  }

  body.innerHTML = html
  body.querySelector('#lok-back')?.addEventListener('click', () => { state = 'menu'; render() })

  body.querySelectorAll('.add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id')!
      // Find the item in the sections
      for (const items of Object.values(sections)) {
        const item = items.find(i => i.id === id)
        if (item) {
          const existing = cart.find(c => c.item.id === id)
          if (existing) existing.quantity++
          else cart.push({ item, quantity: 1, notes: '' })
          break
        }
      }
      updateCartButton()
    })
  })
}

function updateCartButton() {
  const footer = container.querySelector('.modal-footer')
  if (!footer) return
  const count = cart.reduce((s, i) => s + i.quantity, 0)
  const total = cart.reduce((s, i) => s + i.item.price * i.quantity, 0)
  footer.innerHTML = count > 0
    ? `<button class="primary-btn" id="lok-view-cart">View Cart · ${count} items · ₹${total}</button>`
    : ''
  footer.querySelector('#lok-view-cart')?.addEventListener('click', () => { state = 'cart'; render() })
}

async function loadResources() {
  try {
    const data = await api<{ resources: Resource[] }>(`/widget/resources/${config.orgId}`)
    renderResourceList(data.resources)
  } catch {
    state = 'error'
    render()
  }
}

function renderResources(body: Element, footer: Element) {
  body.innerHTML = `
    <button class="back-btn" id="lok-back">← Back</button>
    <div class="loading"><div class="spinner"></div><p>Loading...</p></div>
  `
  footer.innerHTML = ''
  body.querySelector('#lok-back')?.addEventListener('click', () => { state = 'menu'; render() })
}

function renderResourceList(resources: Resource[]) {
  const body = container.querySelector('.modal-body')
  if (!body) return

  let html = `<button class="back-btn" id="lok-back">← Back</button>`

  if (resources.length === 0) {
    html += `<div class="loading"><p>No availability right now.</p></div>`
  } else {
    for (const r of resources) {
      html += `
        <div class="resource-card ${selectedResource?.id === r.id ? 'selected' : ''}" data-id="${r.id}">
          <h4>${r.name}</h4>
          ${r.specialization ? `<p>${r.specialization}</p>` : ''}
          ${r.price_per_slot ? `<div class="price">₹${r.price_per_slot} ${r.consultation_duration_minutes ? `/ ${r.consultation_duration_minutes} min` : ''}</div>` : ''}
        </div>
      `
    }
  }

  body.innerHTML = html
  body.querySelector('#lok-back')?.addEventListener('click', () => { state = 'menu'; render() })

  body.querySelectorAll('.resource-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-id')!
      selectedResource = resources.find(r => r.id === id) ?? null
      state = 'slots'
      render()
      if (selectedResource) loadSlots(selectedResource.id)
    })
  })
}

async function loadSlots(resourceId: string) {
  try {
    const data = await api<{ dates: Record<string, Slot[]> }>(
      `/widget/availability/${resourceId}`
    )
    renderSlotGrid(data.dates)
  } catch {
    state = 'error'
    render()
  }
}

function renderSlots(body: Element, footer: Element) {
  body.innerHTML = `
    <button class="back-btn" id="lok-back">← Back</button>
    ${selectedResource ? `<div style="margin-bottom:12px"><strong>${selectedResource.name}</strong></div>` : ''}
    <div class="loading"><div class="spinner"></div><p>Loading slots...</p></div>
  `
  footer.innerHTML = ''
  body.querySelector('#lok-back')?.addEventListener('click', () => {
    selectedSlot = null
    state = 'resources'
    render()
    loadResources()
  })
}

function renderSlotGrid(dates: Record<string, Slot[]>) {
  const body = container.querySelector('.modal-body')
  const footer = container.querySelector('.modal-footer')
  if (!body || !footer) return

  let html = `<button class="back-btn" id="lok-back">← Back</button>`
  html += `<div style="margin-bottom:12px"><strong>${selectedResource?.name ?? 'Select a time'}</strong></div>`

  const entries = Object.entries(dates)
  if (entries.length === 0) {
    html += `<div class="loading"><p>No available slots in the next 7 days.</p></div>`
  } else {
    for (const [date, slots] of entries) {
      const d = new Date(date)
      html += `<div class="slot-date">${d.toLocaleDateString('en-IN', { weekday: 'long', month: 'short', day: 'numeric' })}</div>`
      html += `<div class="slot-grid">`
      for (const slot of slots) {
        const time = new Date(slot.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
        html += `<button class="slot-btn ${selectedSlot?.id === slot.id ? 'selected' : ''}" data-id="${slot.id}">${time}</button>`
      }
      html += `</div>`
    }
  }

  body.innerHTML = html

  // Re-store the full slot objects for selection
  const allSlots = entries.flatMap(([, slots]) => slots)

  body.querySelector('#lok-back')?.addEventListener('click', () => {
    selectedSlot = null
    state = 'resources'
    render()
    loadResources()
  })

  body.querySelectorAll('.slot-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id')!
      selectedSlot = allSlots.find(s => s.id === id) ?? null
      // Update selection visuals
      body.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'))
      btn.classList.add('selected')

      footer.innerHTML = selectedSlot
        ? `<button class="primary-btn" id="lok-book-slot">Book This Slot</button>`
        : ''
      footer.querySelector('#lok-book-slot')?.addEventListener('click', () => {
        state = 'checkout'
        render()
      })
    })
  })
}

function renderCart(body: Element, footer: Element) {
  let html = `<button class="back-btn" id="lok-back">← Back to menu</button>`
  html += `<div class="cart-summary">`

  for (const ci of cart) {
    html += `
      <div class="cart-item">
        <span>${ci.item.name} × ${ci.quantity}</span>
        <span>₹${ci.item.price * ci.quantity}</span>
      </div>
    `
  }

  const total = cart.reduce((s, i) => s + i.item.price * i.quantity, 0)
  html += `<div class="cart-total"><span>Total</span><span>₹${total}</span></div>`
  html += `</div>`

  body.innerHTML = html
  footer.innerHTML = `<button class="primary-btn" id="lok-checkout">Proceed to Checkout</button>`

  body.querySelector('#lok-back')?.addEventListener('click', () => {
    state = 'catalog'
    render()
    loadCatalog()
  })
  footer.querySelector('#lok-checkout')?.addEventListener('click', () => { state = 'checkout'; render() })
}

function renderCheckout(body: Element, footer: Element) {
  const isAppointment = selectedSlot !== null
  const isOrder = cart.length > 0

  let html = `<button class="back-btn" id="lok-back">← Back</button>`

  if (isAppointment && selectedResource && selectedSlot) {
    const time = new Date(selectedSlot.time)
    html += `
      <div class="cart-summary">
        <div class="cart-item"><span>${selectedResource.name}</span></div>
        <div class="cart-item">
          <span>${time.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
          <span>${time.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>
    `
  }

  html += `
    <div class="form-group">
      <label>Your Phone Number *</label>
      <input class="form-input" id="lok-phone" type="tel" placeholder="+91 98765 43210" required>
    </div>
    <div class="form-group">
      <label>Your Name</label>
      <input class="form-input" id="lok-name" type="text" placeholder="John Doe">
    </div>
    ${!isAppointment && !isOrder ? `
    <div class="form-group">
      <label>What do you need?</label>
      <input class="form-input" id="lok-notes" type="text" placeholder="Describe your request...">
    </div>` : ''}
  `

  body.innerHTML = html
  footer.innerHTML = `<button class="primary-btn" id="lok-submit">
    ${isAppointment ? 'Confirm Booking' : isOrder ? 'Place Order' : 'Submit Request'}
  </button>`

  body.querySelector('#lok-back')?.addEventListener('click', () => {
    if (isOrder) { state = 'cart' }
    else if (isAppointment) { state = 'slots'; loadSlots(selectedResource!.id) }
    else { state = 'menu' }
    render()
  })

  footer.querySelector('#lok-submit')?.addEventListener('click', submitBooking)
}

async function submitBooking() {
  const phone = (shadow.getElementById('lok-phone') as HTMLInputElement)?.value
  const name = (shadow.getElementById('lok-name') as HTMLInputElement)?.value
  const notes = (shadow.getElementById('lok-notes') as HTMLInputElement)?.value

  if (!phone || phone.length < 10) {
    alert('Please enter a valid phone number')
    return
  }

  const submitBtn = shadow.getElementById('lok-submit') as HTMLButtonElement
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting...' }

  try {
    const isOrder = cart.length > 0
    const isAppointment = selectedSlot !== null

    const payload: any = {
      orgId: config.orgId,
      customerPhone: phone,
      customerName: name || undefined,
      bookingType: isOrder ? 'order' : isAppointment ? 'appointment' : 'quote',
      notes: notes || undefined,
    }

    if (isAppointment && selectedResource && selectedSlot) {
      payload.resourceId = selectedResource.id
      payload.slotId = selectedSlot.id
    }

    if (isOrder) {
      payload.items = cart.map(ci => ({
        catalogItemId: ci.item.id,
        quantity: ci.quantity,
        notes: ci.notes || undefined,
      }))
    }

    await api('/widget/book', {
      method: 'POST',
      body: JSON.stringify(payload),
    })

    // Reset
    cart = []
    selectedResource = null
    selectedSlot = null
    state = 'success'
    render()
  } catch (err) {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Try Again' }
  }
}

function renderSuccess(body: Element, footer: Element) {
  body.innerHTML = `
    <div class="success-view">
      <div class="success-icon">✓</div>
      <h3>Booking Confirmed!</h3>
      <p>You'll receive a confirmation on your phone shortly.</p>
    </div>
  `
  footer.innerHTML = `<button class="primary-btn" id="lok-done">Done</button>`
  footer.querySelector('#lok-done')?.addEventListener('click', () => {
    state = 'closed'
    container.querySelector('.locogi-modal')?.classList.add('hidden')
  })
}

// ─── Initialization ─────────────────────────────────────────────────────────

async function loadOrgConfig() {
  try {
    orgConfig = await api<OrgConfig>(`/widget/config/${config.orgId}`)
    state = orgConfig.bookingTypes.length === 1 ? getInitialView(orgConfig.bookingTypes[0]) : 'menu'
    render()

    // If single booking type, jump directly
    if (state === 'catalog') loadCatalog()
    if (state === 'resources') loadResources()
  } catch {
    state = 'error'
    render()
  }
}

function getInitialView(type: string): typeof state {
  switch (type) {
    case 'order': return 'catalog'
    case 'appointment': return 'resources'
    default: return 'checkout'
  }
}

function init(userConfig: Partial<WidgetConfig> & { orgId: string }) {
  config = {
    orgId: userConfig.orgId,
    apiUrl: userConfig.apiUrl ?? 'https://api.locogi.com',
    theme: userConfig.theme ?? 'dark',
    position: userConfig.position ?? 'bottom-right',
    primaryColor: userConfig.primaryColor ?? '#6366f1',
    buttonText: userConfig.buttonText,
  }

  // Resolve theme
  let resolvedTheme = config.theme!
  if (resolvedTheme === 'auto') {
    resolvedTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  // Create shadow DOM host
  const host = document.createElement('div')
  host.id = 'locogi-widget-host'
  document.body.appendChild(host)
  shadow = host.attachShadow({ mode: 'closed' })

  // Inject styles
  const style = document.createElement('style')
  style.textContent = getStyles(resolvedTheme, config.primaryColor!)
  shadow.appendChild(style)

  // Create FAB button
  const fab = document.createElement('button')
  fab.className = `locogi-fab ${config.position === 'bottom-left' ? 'left' : ''}`
  fab.innerHTML = config.buttonText
    ? `<span style="font-size:13px;font-weight:600">${config.buttonText}</span>`
    : '📅'
  fab.addEventListener('click', toggleWidget)
  shadow.appendChild(fab)

  // Create modal
  container = document.createElement('div')
  container.className = `locogi-modal hidden ${config.position === 'bottom-left' ? 'left' : ''}`
  container.innerHTML = `
    <div class="modal-header">
      <div>
        <h3 id="lok-title">Book Now</h3>
      </div>
      <button class="close-btn" id="lok-close">×</button>
    </div>
    <div class="modal-body"></div>
    <div class="modal-footer"></div>
  `
  shadow.appendChild(container)

  container.querySelector('#lok-close')?.addEventListener('click', () => {
    state = 'closed'
    container.classList.add('hidden')
  })
}

function toggleWidget() {
  if (state === 'closed') {
    state = 'loading'
    container.classList.remove('hidden')
    render()
    loadOrgConfig()
  } else {
    state = 'closed'
    container.classList.add('hidden')
  }
}

// ─── Auto-init from script tag attributes ───────────────────────────────────

function autoInit() {
  const script = document.currentScript ?? document.querySelector('script[data-org-id]')
  if (!script) return

  const orgId = script.getAttribute('data-org-id')
  if (!orgId) return

  init({
    orgId,
    apiUrl: script.getAttribute('data-api-url') ?? undefined,
    theme: (script.getAttribute('data-theme') as any) ?? undefined,
    position: (script.getAttribute('data-position') as any) ?? undefined,
    primaryColor: script.getAttribute('data-primary-color') ?? undefined,
    buttonText: script.getAttribute('data-button-text') ?? undefined,
  })
}

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoInit)
} else {
  autoInit()
}

// Export for programmatic use
;(window as any).LocogiWidget = { init }
export { init }
