import { Droplets, Heart, Shield } from 'lucide-react';

const roleCards = [
  {
    role: 'coordinator',
    title: 'Coordinator',
    subtitle: 'Manage patients, donors, and daily operations',
    icon: Shield,
    className: 'red',
  },
  {
    role: 'patient',
    title: 'Patient / Family',
    subtitle: 'Request blood and track your transfusion schedule',
    icon: Heart,
    className: 'blue',
  },
  {
    role: 'donor',
    title: 'Donor',
    subtitle: 'Respond to requests and view your donation history',
    icon: Droplets,
    className: 'green',
  },
];

export default function RoleSelect({ onSelectRole }) {
  return (
    <div className="role-screen">
      <div>
        <div className="role-logo">
          <h1>IDMS</h1>
          <p>Blood Warriors Intelligence System</p>
        </div>
        <div className="role-card-row">
          {roleCards.map((card) => {
            const Icon = card.icon;
            return (
              <button
                key={card.role}
                type="button"
                className={`role-card ${card.className}`}
                onClick={() => onSelectRole(card.role)}
              >
                <div className={`role-card-icon ${card.className}`}>
                  <Icon size={22} />
                </div>
                <div className="role-card-title">{card.title}</div>
                <div className="role-card-subtitle">{card.subtitle}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
