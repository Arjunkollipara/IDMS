import { Link, Outlet, useLocation } from 'react-router-dom';
export function CoordinatorLayout({ onSwitchRole }) {
  const location = useLocation();
  const links = [
    { to: '/', label: "Today's Actions" },
    { to: '/patients', label: 'Patients' },
    { to: '/donors', label: 'Donors' },
    { to: '/insights', label: 'Insights' },
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div className="sidebar-logo-title">IDMS</div>
          <div className="sidebar-logo-sub">Coordinator</div>
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
          <div className="section-title">Coordinator dashboard</div>
        </div>
        <div className="page"><Outlet /></div>
      </main>
    </div>
  );
}
