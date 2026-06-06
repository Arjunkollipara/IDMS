import { Link, NavLink } from "react-router-dom";
import {
  AlertTriangle,
  BarChart2,
  Heart,
  Loader2,
  MessageSquare,
  LayoutDashboard,
  Users,
  ChevronRight,
  X,
} from "lucide-react";
import { getStageMeta } from "../utils";

export function Spinner({ label = "Loading..." }) {
  return (
    <div className="spinner-wrap">
      <Loader2 className="spin-icon" size={22} />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="error-state card">
      <AlertTriangle size={18} />
      <div>
        <h3>Something went wrong</h3>
        <p>{error}</p>
      </div>
      {onRetry ? (
        <button className="btn btn-primary" type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Badge({ tone = "muted", children, className = "" }) {
  return <span className={`badge badge-${tone} ${className}`.trim()}>{children}</span>;
}

export function Card({ children, className = "" }) {
  return <div className={`card ${className}`.trim()}>{children}</div>;
}

export function PageHeader({ title, subtitle, action }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {action ? <div className="page-action">{action}</div> : null}
    </div>
  );
}

export function StatCard({ icon: Icon, label, value, tone = "muted", trend = null }) {
  return (
    <Card className="stat-card">
      <div className={`stat-icon stat-${tone}`}>
        <Icon size={18} />
      </div>
      <div className="stat-body">
        <span>{label}</span>
        <strong>{value}</strong>
        {trend ? <small>{trend}</small> : null}
      </div>
    </Card>
  );
}

export function Sidebar() {
  const items = [
    { to: "/", label: "Dashboard", icon: LayoutDashboard },
    { to: "/donors", label: "Donors", icon: Users },
    { to: "/patients", label: "Patients", icon: Heart },
    { to: "/conversations", label: "Conversations", icon: MessageSquare },
    { to: "/insights", label: "Insights", icon: BarChart2 },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <Link className="brand" to="/">
          <span>IDMS</span>
          <small>Blood Intelligence</small>
        </Link>
        <nav className="nav">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                <ChevronRight size={14} className="nav-arrow" />
              </NavLink>
            );
          })}
        </nav>
      </div>
      <div className="sidebar-footer">v1.0 — Blood Warriors</div>
    </aside>
  );
}

export function Shell({ children }) {
  return <div className="app-shell">{children}</div>;
}

export function Drawer({ title, open, onClose, children, width = 400 }) {
  return (
    <>
      <div className={`drawer-backdrop ${open ? "open" : ""}`} onClick={onClose} />
      <aside
        className={`drawer ${open ? "open" : ""}`}
        style={{ width: `${width}px` }}
        aria-hidden={!open}
      >
        <div className="drawer-head">
          <div>
            <h3>{title}</h3>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close panel">
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

export function Modal({ title, open, onClose, children, footer = null }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function StageBadge({ stage, daysUntil = null }) {
  const meta = getStageMeta(stage, daysUntil);
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}
