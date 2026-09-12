export default function DashboardPage() {
  return (
    <>
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>Today&apos;s overview · {new Date().toLocaleDateString('en-IN', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p>
      </div>

      {/* KPI Cards */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Today&apos;s Bookings</div>
          <div className="kpi-value primary">24</div>
          <div className="kpi-change up">↑ 12% from yesterday</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Revenue Today</div>
          <div className="kpi-value success">₹18,450</div>
          <div className="kpi-change up">↑ 8% from yesterday</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Pending Orders</div>
          <div className="kpi-value warning">7</div>
          <div className="kpi-change">Needs attention</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Completion Rate</div>
          <div className="kpi-value">94%</div>
          <div className="kpi-change up">↑ 3% this week</div>
        </div>
      </div>

      {/* Recent Bookings */}
      <div className="card">
        <div className="card-header">
          <h2>Recent Bookings</h2>
          <a href="/bookings" className="btn btn-outline">View All</a>
        </div>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Type</th>
                <th>Status</th>
                <th>Amount</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>Rahul Sharma</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>+91 98765 43210</div>
                </td>
                <td><span className="badge badge-appointment">Appointment</span></td>
                <td><span className="badge badge-confirmed">Confirmed</span></td>
                <td style={{ fontWeight: 600 }}>₹500</td>
                <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>2:30 PM</td>
              </tr>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>Priya Reddy</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>+91 87654 32109</div>
                </td>
                <td><span className="badge badge-order">Order</span></td>
                <td><span className="badge badge-open">Pending</span></td>
                <td style={{ fontWeight: 600 }}>₹1,250</td>
                <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>1:15 PM</td>
              </tr>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>Arun Kumar</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>+91 76543 21098</div>
                </td>
                <td><span className="badge badge-quote">Quote</span></td>
                <td><span className="badge badge-completed">Completed</span></td>
                <td style={{ fontWeight: 600 }}>₹3,500</td>
                <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>11:00 AM</td>
              </tr>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>Sneha Patel</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>+91 65432 10987</div>
                </td>
                <td><span className="badge badge-appointment">Appointment</span></td>
                <td><span className="badge badge-confirmed">Confirmed</span></td>
                <td style={{ fontWeight: 600 }}>₹800</td>
                <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>10:30 AM</td>
              </tr>
              <tr>
                <td>
                  <div style={{ fontWeight: 600 }}>Karthik Nair</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>+91 54321 09876</div>
                </td>
                <td><span className="badge badge-order">Order</span></td>
                <td><span className="badge badge-cancelled">Cancelled</span></td>
                <td style={{ fontWeight: 600, textDecoration: 'line-through', color: 'var(--text-muted)' }}>₹950</td>
                <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>9:45 AM</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Quick Actions + Activity */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div className="card">
          <div className="card-header">
            <h2>Quick Actions</h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button className="btn btn-primary" style={{ justifyContent: 'center' }}>
              ➕ New Booking
            </button>
            <button className="btn btn-outline" style={{ justifyContent: 'center' }}>
              📦 Update Catalog
            </button>
            <button className="btn btn-outline" style={{ justifyContent: 'center' }}>
              📅 Manage Slots
            </button>
            <button className="btn btn-outline" style={{ justifyContent: 'center' }}>
              🔗 Get Widget Code
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2>Today&apos;s Activity</h2>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {[
              { time: '2:30 PM', text: 'New appointment confirmed — Dr. Patel', color: 'var(--success)' },
              { time: '1:15 PM', text: 'Order #142 placed — 3 items', color: 'var(--warning)' },
              { time: '12:00 PM', text: 'Webhook delivered to pos.restaurant.com', color: 'var(--primary-light)' },
              { time: '11:30 AM', text: 'Catalog synced — 12 items updated', color: 'var(--text-muted)' },
              { time: '10:00 AM', text: 'Widget booking — Sneha via website', color: 'var(--success)' },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 12, color: 'var(--text-dim)', minWidth: 60, paddingTop: 2 }}>{item.time}</span>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: item.color, marginTop: 7, flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
