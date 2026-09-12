export default function SettingsPage() {
  return (
    <>
      <div className="page-header">
        <h1>Settings</h1>
        <p>Manage your API keys, webhooks, and widget configuration</p>
      </div>

      <div className="tabs">
        <button className="tab active">API Keys</button>
        <button className="tab">Webhooks</button>
        <button className="tab">Widget</button>
        <button className="tab">Branding</button>
      </div>

      {/* API Keys Section */}
      <div className="card">
        <div className="card-header">
          <h2>API Keys</h2>
          <button className="btn btn-primary">+ Generate New Key</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
          Use API keys to integrate Locogi with your systems. Keys are scoped to your organization.
        </p>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Label</th>
                <th>Environment</th>
                <th>Last Used</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code className="code-block" style={{ display: 'inline', padding: '4px 10px', fontSize: 12 }}>lok_live_a3f9bc12...</code></td>
                <td>Website Widget</td>
                <td><span className="badge badge-confirmed">Live</span></td>
                <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>2 hours ago</td>
                <td><button className="btn btn-danger" style={{ padding: '6px 14px', fontSize: 12 }}>Revoke</button></td>
              </tr>
              <tr>
                <td><code className="code-block" style={{ display: 'inline', padding: '4px 10px', fontSize: 12 }}>lok_test_7e2d1f08...</code></td>
                <td>Staging</td>
                <td><span className="badge badge-open">Test</span></td>
                <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>5 days ago</td>
                <td><button className="btn btn-danger" style={{ padding: '6px 14px', fontSize: 12 }}>Revoke</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Webhooks Section */}
      <div className="card">
        <div className="card-header">
          <h2>Webhooks</h2>
          <button className="btn btn-primary">+ Add Webhook</button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
          Receive real-time notifications when bookings are created, confirmed, or cancelled.
        </p>

        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>URL</th>
                <th>Events</th>
                <th>Status</th>
                <th>Last Delivery</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ fontSize: 13 }}>https://pos.myrestaurant.com/webhook</td>
                <td><span className="badge badge-confirmed">All Events</span></td>
                <td><span className="badge badge-confirmed">Active</span></td>
                <td style={{ color: 'var(--text-muted)', fontSize: 13 }}>3 min ago</td>
                <td><button className="btn btn-danger" style={{ padding: '6px 14px', fontSize: 12 }}>Remove</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Widget Embed Code */}
      <div className="card">
        <div className="card-header">
          <h2>Widget Embed Code</h2>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Add this code to your website to enable the booking widget. Customers can book directly from your site.
        </p>
        <div className="code-block" style={{ whiteSpace: 'pre', lineHeight: 1.6 }}>
{`<script
  src="https://widget.locogi.com/v1.js"
  data-org-id="your-org-uuid"
  data-api-url="https://api.locogi.com"
  data-theme="dark"
  data-primary-color="#6366f1">
</script>`}
        </div>
        <button className="btn btn-outline" style={{ marginTop: 12 }}>
          📋 Copy to Clipboard
        </button>
      </div>
    </>
  )
}
