import { useEffect, useState } from 'react';
import { getNotificationsLog, postConfirm, postRelease, postSonarRespond, getDonors, postReserve, postSaveMessage } from '../api.js';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDate } from '../utils.js';

export function DonorNotifications({ donorId }) {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();
  const [donors, setDonors] = useState([]);
  const [selectedDonorId, setSelectedDonorId] = useState('');

  // Load saved donor selection
  useEffect(() => {
    const saved = localStorage.getItem('idms_donor_id');
    if (saved) setSelectedDonorId(saved);
  }, []);

  // Fetch donors list on mount
  useEffect(() => {
    async function fetchDonors() {
      try {
        const data = await getDonors({ category: 'Bridge Donor', limit: 100 });
        setDonors(data);
      } catch (err) {
        console.error('Failed to fetch donors:', err);
      }
    }
    fetchDonors();
  }, []);

  // Update localStorage when selection changes
  useEffect(() => {
    if (selectedDonorId) localStorage.setItem('idms_donor_id', selectedDonorId);
  }, [selectedDonorId]);

  const activeDonorId = selectedDonorId || donorId;

  useEffect(() => {
    let mounted = true;
    let intervalId;

    async function loadNotifications() {
      if (!mounted) return;
      if (mounted) setLoading(true);
      try {
        const result = await getNotificationsLog(activeDonorId);
        if (mounted) {
          setNotifications(Array.isArray(result) ? result : []);
        }
      } catch (err) {
        console.error('Error loading notifications:', err);
        if (mounted) {
          setNotifications([]);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    if (!activeDonorId) {
      setNotifications([]);
      setLoading(false);
      return undefined;
    }

    loadNotifications();
    intervalId = window.setInterval(loadNotifications, 30000);

    return () => {
      mounted = false;
      window.clearInterval(intervalId);
    };
  }, [activeDonorId]);

  async function handleConfirm(notification) {
    try {
      if (notification.notification_type === 'sonar_ping') {
        await postSonarRespond(notification.id, 'YES');
      } else if (
        notification.notification_type === 'donation_accepted' ||
        notification.notification_type?.startsWith('outreach_stage_')
      ) {
        // Reserve the donation slot
        const transfusionDate = new Date().toISOString().split('T')[0];
        await postReserve(activeDonorId, notification.patient_id, transfusionDate);
        // Save confirmation message to conversation history
        await postSaveMessage(
          activeDonorId,
          notification.patient_id,
          'I confirm — I am available and ready to donate.',
          'user'
        );
      } else {
        await postConfirm(notification.id);
      }
      showToast('Donation confirmed! Thank you 🩸', 'success');
      setNotifications((current) => current.filter((item) => item.id !== notification.id));
    } catch (err) {
      console.error('Error confirming notification:', err);
      showToast('Failed to confirm request', 'error');
    }
  }

  async function handleDecline(notification) {
    try {
      if (notification.notification_type === 'sonar_ping') {
        await postSonarRespond(notification.id, 'NO');
      } else {
        await postRelease(notification.id);
      }
      showToast('Notification declined.', 'success');
      setNotifications((current) => current.filter((item) => item.id !== notification.id));
    } catch (err) {
      console.error('Error declining notification:', err);
      showToast('Failed to decline request', 'error');
    }
  }

  if (loading) {
    return <LoadingSpinner label="Loading notifications" />;
  }

  return (
    <div>
      <h2>Pending requests</h2>
      <div className="card" style={{ marginBottom: '1rem' }}>
        <select
          value={selectedDonorId}
          onChange={(e) => setSelectedDonorId(e.target.value)}
          className="form-select"
        >
          <option value="">Select a donor...</option>
          {donors.map((d, index) => (
            <option key={d.user_id} value={d.user_id}>
              Donor {index + 1} — {d.blood_group || 'Unknown'} — {d.donor_category || 'Bridge Donor'}
            </option>
          ))}
        </select>
      </div>
      {activeDonorId ? (
        <>
          {Array.isArray(notifications) && notifications.length > 0 ? (
            notifications.map((notification) => (
              <div key={notification.id} className="card" style={{ marginBottom: '0.75rem' }}>
                <strong>{notification.message ?? `Request from patient ${notification.patient_id}`}</strong>
                <p>Patient: {notification.patient_id ?? 'unknown'}</p>
                <p>Type: {notification.notification_type ?? notification.channel ?? 'unknown'}</p>
                <p>Sent: {formatDate(notification.sent_at) ?? 'unknown'}</p>
                {notification.response ? <p>Response: {notification.response}</p> : null}
                <div className="button-row">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => handleConfirm(notification)}>
                    Confirm
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => handleDecline(notification)}>
                    Decline
                  </button>
                </div>
              </div>
            ))
          ) : (
            <EmptyState title="No pending requests" message="You have no donation requests at this time." />
          )}
        </>
      ) : (
        <EmptyState title="No donor selected" message="Please select a donor profile to view notifications." />
      )}
    </div>
  );
}
