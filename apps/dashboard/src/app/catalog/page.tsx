export default function CatalogPage() {
  const sections = [
    {
      name: 'Starters',
      items: [
        { name: 'Paneer Tikka', price: 280, isVeg: true, available: true },
        { name: 'Chicken 65', price: 320, isVeg: false, available: true },
        { name: 'Veg Spring Rolls', price: 200, isVeg: true, available: false },
      ],
    },
    {
      name: 'Main Course',
      items: [
        { name: 'Hyderabadi Biryani', price: 350, isVeg: false, available: true },
        { name: 'Paneer Butter Masala', price: 280, isVeg: true, available: true },
        { name: 'Dal Makhani', price: 220, isVeg: true, available: true },
        { name: 'Butter Chicken', price: 340, isVeg: false, available: true },
      ],
    },
    {
      name: 'Desserts',
      items: [
        { name: 'Gulab Jamun', price: 120, isVeg: true, available: true },
        { name: 'Double Ka Meetha', price: 150, isVeg: true, available: true },
      ],
    },
  ]

  return (
    <>
      <div className="page-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1>Catalog</h1>
            <p>Manage your menu items, services, and pricing</p>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-outline">↑ Import CSV</button>
            <button className="btn btn-primary">+ Add Item</button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <input
          type="search"
          className="form-input"
          placeholder="Search items..."
          style={{ maxWidth: 300, padding: '8px 12px' }}
        />
        <select className="form-select" style={{ width: 140, padding: '8px 12px' }}>
          <option>All Sections</option>
          <option>Starters</option>
          <option>Main Course</option>
          <option>Desserts</option>
        </select>
      </div>

      {sections.map((section) => (
        <div key={section.name} style={{ marginBottom: 28 }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 12
          }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 }}>
              {section.name}
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dim)', marginLeft: 8 }}>
                ({section.items.length} items)
              </span>
            </h3>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Item</th>
                  <th>Price</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {section.items.map((item, i) => (
                  <tr key={i}>
                    <td style={{ width: 40 }}>
                      <div style={{
                        width: 16, height: 16, border: `2px solid ${item.isVeg ? '#22c55e' : '#ef4444'}`,
                        borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center'
                      }}>
                        <div style={{
                          width: 7, height: 7, borderRadius: '50%',
                          background: item.isVeg ? '#22c55e' : '#ef4444'
                        }} />
                      </div>
                    </td>
                    <td style={{ fontWeight: 600 }}>{item.name}</td>
                    <td style={{ fontWeight: 600, color: 'var(--primary-light)' }}>₹{item.price}</td>
                    <td>
                      <span className={`badge ${item.available ? 'badge-confirmed' : 'badge-cancelled'}`}>
                        {item.available ? 'Available' : 'Unavailable'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 11 }}>Edit</button>
                        <button className="btn btn-outline" style={{ padding: '4px 10px', fontSize: 11 }}>
                          {item.available ? 'Disable' : 'Enable'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {/* Stats */}
      <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="kpi-card">
          <div className="kpi-label">Total Items</div>
          <div className="kpi-value primary">9</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Available</div>
          <div className="kpi-value success">8</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Avg. Price</div>
          <div className="kpi-value">₹251</div>
        </div>
      </div>
    </>
  )
}
