import { Link, Outlet, useLocation } from 'react-router-dom';
export function PatientLayout({ onSwitchRole }) {
  const location = useLocation();
  const links = [
    { to: '/', label: 'Dashboard' },
    { to: '/request', label: 'Request Blood' },
    { to: '/history', label: 'History' },
    { to: '/notifications', label: 'Notifications' },
  ];
  return (
    <div className="app-shell patient-sidebar">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-title">IDMS</div>
          <div className="sidebar-logo-sub">Patient</div>
        </div>
        <nav className="sidebar-nav">
          {links.map((link) => (
            <Link key={link.to} to={link.to} className={`nav-item ${location.pathname === link.to ? 'active' : ''}`}>
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSwitchRole}>
            Switch role
          </button>
        </div>
      </aside>
      <main className="main">
        <div className="topbar">
          <div className="section-title">Patient portal</div>
        </div>
        <div className="page"><Outlet /></div>
      </main>
    </div>
  );
}
