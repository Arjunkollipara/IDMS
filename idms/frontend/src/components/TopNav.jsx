import { LogOut } from 'lucide-react';

export function TopNav({ role, onSwitchRole }) {
  const roleLabel = role === 'coordinator' ? 'Coordinator' : role === 'patient' ? 'Patient' : 'Donor';
  return (
    <div className="topbar">
      <div className="section-title">
        {roleLabel === 'Coordinator' && "Coordinator Dashboard"}
        {roleLabel === 'Patient' && "Patient Portal"}
        {roleLabel === 'Donor' && "Donor Dashboard"}
      </div>
      <div className="top-nav">
        <div className="role-badge">{roleLabel}</div>
        <button type="button" className="btn btn-ghost" onClick={onSwitchRole} title="Switch role">
          <LogOut size={18} />
          Switch
        </button>
      </div>
    </div>
  );
}

export default TopNav;
