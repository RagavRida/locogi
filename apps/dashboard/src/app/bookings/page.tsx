export default function BookingsPage() {
  return (
    <>
      <div className="page-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1>Bookings</h1>
            <p>Manage all your appointments, orders, and quotes</p>
          </div>
          <button className="btn btn-primary">+ New Booking</button>
        </div>
      </div>

      <div className="tabs">
        <button className="tab active">All (156)</button>
        <button className="tab">Confirmed (42)</button>
        <button className="tab">Pending (7)</button>
        <button className="tab">Completed (98)</button>
        <button className="tab">Cancelled (9)</button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
        <select className="form-select" style={{ width: 160, padding: '8px 12px' }}>
          <option>All Types</option>
          <option>Appointment</option>
          <option>Order</option>
          <option>Quote</option>
          <option>Hiring</option>
        </select>
        <input
          type="date"
          className="form-input"
          style={{ width: 160, padding: '8px 12px' }}
        />
        <input
          type="search"
          className="form-input"
          placeholder="Search by name or phone..."
          style={{ flex: 1, padding: '8px 12px' }}
        />
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Type</th>
                <th>Description</th>
                <th>Status</th>
                <th>Amount</th>
                <th>Scheduled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {[
                { name: 'Rahul Sharma', phone: '+91 98765 43210', type: 'appointment', desc: 'Dr. Patel - Cardiology', status: 'confirmed', amount: 500, time: 'Today, 2:30 PM' },
                { name: 'Priya Reddy', phone: '+91 87654 32109', type: 'order', desc: 'Biryani x2, Kebab x1', status: 'open', amount: 1250, time: 'Today, 1:15 PM' },
                { name: 'Arun Kumar', phone: '+91 76543 21098', type: 'quote', desc: 'AC Repair - 2 units', status: 'completed', amount: 3500, time: 'Today, 11:00 AM' },
                { name: 'Sneha Patel', phone: '+91 65432 10987', type: 'appointment', desc: 'Haircut + Facial', status: 'confirmed', amount: 800, time: 'Today, 10:30 AM' },
                { name: 'Karthik Nair', phone: '+91 54321 09876', type: 'order', desc: 'Pizza x3, Pasta x2', status: 'cancelled', amount: 950, time: 'Yesterday, 8:00 PM' },
                { name: 'Meera Joshi', phone: '+91 43210 98765', type: 'appointment', desc: 'Dental Cleaning', status: 'completed', amount: 1200, time: 'Yesterday, 4:00 PM' },
                { name: 'Vikram Singh', phone: '+91 32109 87654', type: 'hiring', desc: 'Cook for house party', status: 'open', amount: null, time: 'Yesterday, 2:00 PM' },
                { name: 'Lakshmi Devi', phone: '+91 21098 76543', type: 'order', desc: 'Thali x4, Curd Rice x2', status: 'completed', amount: 680, time: 'Yesterday, 12:30 PM' },
              ].map((booking, i) => (
                <tr key={i}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{booking.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{booking.phone}</div>
                  </td>
                  <td>
                    <span className={`badge badge-${booking.type}`}>
                      {booking.type.charAt(0).toUpperCase() + booking.type.slice(1)}
                    </span>
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 200 }}>{booking.desc}</td>
                  <td>
                    <span className={`badge badge-${booking.status}`}>
                      {booking.status.charAt(0).toUpperCase() + booking.status.slice(1)}
                    </span>
                  </td>
                  <td style={{ fontWeight: 600 }}>
                    {booking.amount ? `₹${booking.amount.toLocaleString()}` : '—'}
                  </td>
                  <td style={{ fontSize: 13, color: 'var(--text-muted)' }}>{booking.time}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 11 }}>View</button>
                      {booking.status === 'open' && (
                        <button className="btn btn-primary" style={{ padding: '4px 10px', fontSize: 11, boxShadow: 'none' }}>Accept</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
        <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Showing 1-8 of 156 bookings</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" style={{ padding: '6px 14px', fontSize: 12 }}>← Previous</button>
          <button className="btn btn-outline" style={{ padding: '6px 14px', fontSize: 12 }}>Next →</button>
        </div>
      </div>
    </>
  )
}
