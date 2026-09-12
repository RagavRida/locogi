'use client'

import './globals.css'
import { CopilotKit } from '@copilotkit/react-core'
import { CopilotSidebar } from '@copilotkit/react-ui'
import '@copilotkit/react-ui/styles.css'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <title>Locogi Dashboard</title>
        <meta name="description" content="Business management dashboard for Locogi booking engine" />
      </head>
      <body>
        <CopilotKit
          runtimeUrl="/api/copilotkit"
          agent="locogi-vendor-assistant"
        >
          <CopilotSidebar
            defaultOpen={false}
            labels={{
              title: 'Locogi AI Assistant',
              initial: "Hi! I'm your Locogi business assistant. Ask me about orders, revenue, catalog management, or customer messages.",
              placeholder: 'Ask about your business...',
            }}
            clickOutsideToClose={true}
          >
            <div className="layout">
              <aside className="sidebar">
                <div className="sidebar-logo">
                  Loco<span>gi</span>
                </div>

                <nav className="nav-group">
                  <div className="nav-label">Overview</div>
                  <a href="/" className="nav-item active">
                    <span className="nav-icon">📊</span>
                    Dashboard
                  </a>
                  <a href="/demo" className="nav-item">
                    <span className="nav-icon">🎬</span>
                    Live Demo
                  </a>
                </nav>

                <nav className="nav-group">
                  <div className="nav-label">Operations</div>
                  <a href="/bookings" className="nav-item">
                    <span className="nav-icon">📋</span>
                    Bookings
                  </a>
                  <a href="/orders" className="nav-item">
                    <span className="nav-icon">🛒</span>
                    Orders
                  </a>
                  <a href="/catalog" className="nav-item">
                    <span className="nav-icon">📦</span>
                    Catalog
                  </a>
                  <a href="/resources" className="nav-item">
                    <span className="nav-icon">👤</span>
                    Resources
                  </a>
                  <a href="/schedule" className="nav-item">
                    <span className="nav-icon">📅</span>
                    Schedule
                  </a>
                </nav>

                <nav className="nav-group">
                  <div className="nav-label">Business</div>
                  <a href="/analytics" className="nav-item">
                    <span className="nav-icon">📈</span>
                    Analytics
                  </a>
                  <a href="/settings" className="nav-item">
                    <span className="nav-icon">⚙️</span>
                    Settings
                  </a>
                </nav>

                <div style={{ flex: 1 }} />

                <div className="nav-item" style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                  <span className="nav-icon">🏢</span>
                  Powered by Locogi Engine
                </div>
              </aside>

              <main className="main">
                {children}
              </main>
            </div>
          </CopilotSidebar>
        </CopilotKit>
      </body>
    </html>
  )
}
