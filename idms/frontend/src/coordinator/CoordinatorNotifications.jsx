import { useEffect, useState } from 'react';
import { getNotificationsLog } from '../api.js';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { formatDate } from '../utils.js';
import './CoordinatorNotifications.css';

export function CoordinatorNotifications({ selectedPatientId }) {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      if (!mounted) return;
      setLoading(true);
      try {
        const data = await getNotificationsLog(null, { patient_id: selectedPatientId });
        const filtered = (Array.isArray(data) ? data : []).filter(
          (n) => n.notification_type === 'donation_accepted'
        );
        if (mounted) setNotifications(filtered);
      } catch (err) {
        console.error('Error loading notifications', err);
        if (mounted) setNotifications([]);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    const interval = setInterval(load, 3000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [selectedPatientId]);

  if (!selectedPatientId) {
    return null;
  }

  if (loading) {
    return <LoadingSpinner label="Loading notifications" />;
  }

  return (
    <div className="card coordinator-notifications" style={{ marginBottom: '1rem' }}>
      <h3>Donor Acceptance Notifications</h3>
      {notifications.length > 0 ? (
        <ul className="notification-list">
          {notifications.map((n) => (
            <li key={n.id} className="notification-item">
              <strong>{n.message || `Donor ${n.donor_id} accepted`}</strong>
              <p>Patient: {n.patient_id}</p>
              <p>Sent: {formatDate(n.sent_at)}</p>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No new acceptances" message="No donors have accepted requests yet." />
      )}
    </div>
  );
}
