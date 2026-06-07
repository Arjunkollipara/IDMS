import { useEffect, useMemo, useState } from 'react';
import { getConversations, getPatients, postChat, getDonors } from '../api.js';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDate, formatDateTime } from '../utils.js';

export function DonorMessages({ donorId }) {
  const [patients, setPatients] = useState([]);
  const [messages, setMessages] = useState([]);
  const [selectedPatientId, setSelectedPatientId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('Hello, I am available to donate. Please let me know the next steps.');
  const [confirmedBanner, setConfirmedBanner] = useState(false);
  const { showToast } = useToast();
  const [donors, setDonors] = useState([]);
  const [selectedDonorId, setSelectedDonorId] = useState('');
  const activeDonorId = selectedDonorId || donorId;

  useEffect(() => {
    // Load saved donor selection
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

  // Persist selection changes
  useEffect(() => {
    if (selectedDonorId) localStorage.setItem('idms_donor_id', selectedDonorId);
  }, [selectedDonorId]);

  // Load patients (unchanged)
  useEffect(() => {
    async function loadPatients() {
      try {
        const patientsData = await getPatients({ limit: 50 });
        const safePatients = Array.isArray(patientsData) ? patientsData : [];
        setPatients(safePatients);
        if (safePatients.length > 0) {
          setSelectedPatientId(safePatients[0].patient_id ?? safePatients[0].user_id ?? safePatients[0].id);
        }
      } catch (err) {
        console.error('Error loading patients:', err);
        setPatients([]);
      } finally {
        setLoading(false);
      }
    }
    loadPatients();
  }, []);

  useEffect(() => {
    if (!activeDonorId || !selectedPatientId) {
      setMessages([]);
      return;
    }

    async function loadConversation() {
      setMessagesLoading(true);
      try {
        const result = await getConversations(activeDonorId, selectedPatientId, 'donor');
        setMessages(result.history || []);
      } catch (err) {
        console.error('Error loading conversation:', err);
        setMessages([]);
      } finally {
        setMessagesLoading(false);
      }
    }

    loadConversation();
  }, [activeDonorId, selectedPatientId, showToast]);

  const currentPatient = useMemo(
    () =>
      patients.find(
        (patient) =>
          patient.patient_id === selectedPatientId ||
          patient.user_id === selectedPatientId ||
          patient.id === selectedPatientId
      ) ?? null,
    [patients, selectedPatientId]
  );

  const CONFIRMATION_WORDS = [
    'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay',
    'haan', 'available', 'confirm', 'i can', 'i will',
    'will help', 'ready', 'can donate', 'can help',
  ];

  async function handleSend(event) {
    event.preventDefault();

    if (!activeDonorId || !selectedPatientId) {
      showToast('Missing donor or patient selection.', 'warning');
      return;
    }

    if (draft.trim() === '') {
      showToast('Message cannot be empty.', 'warning');
      return;
    }

    const sentMessage = draft;
    const isConfirmation = CONFIRMATION_WORDS.some((w) =>
      sentMessage.toLowerCase().includes(w)
    );

    setSending(true);
    try {
      await postChat(activeDonorId, selectedPatientId, sentMessage, 'donor');
      showToast('Message sent successfully.', 'success');
      setDraft('');
      setConfirmedBanner(isConfirmation);
      const refreshed = await getConversations(activeDonorId, selectedPatientId, 'donor');
      setMessages(refreshed.history || []);
    } catch (err) {
      console.error('Error sending message:', err);
      showToast('Failed to send message', 'error');
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return <LoadingSpinner label="Loading messages" />;
  }

  if (!currentPatient) {
    return (
      <EmptyState
        title="No patients available"
        message="A patient profile is needed to start messaging."
      />
    );
  }

  return (
    <div>
      <h2>Messages</h2>
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3>Donor Selector</h3>
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

      <div className="card" style={{ marginBottom: '1rem' }}>
        <h3>Conversation</h3>
        {messagesLoading ? (
          <LoadingSpinner label="Loading conversation" />
        ) : Array.isArray(messages) && messages.length > 0 ? (
          messages.map((message, index) => (
            <div
              key={message.id ?? index}
              className="card"
              style={{
                marginBottom: '0.75rem',
                background: message.role === 'assistant' ? 'rgba(52, 152, 219, 0.08)' : 'rgba(39, 174, 96, 0.08)',
              }}
            >
              <div className="conversation-head">
                <strong>{message.role === 'assistant' ? 'Coordinator' : 'Donor'}</strong>
                <span>{formatDateTime(message.created_at ?? message.time ?? message.timestamp)}</span>
              </div>
              <p>{message.message ?? message.text ?? message.content ?? 'No message body.'}</p>
            </div>
          ))
        ) : (
          <p>No messages have been exchanged yet.</p>
        )}
      </div>

      <div className="card">
        <h3>Send a message</h3>
        <form onSubmit={handleSend}>
          <div className="field-row">
            <textarea
              rows={4}
              className="form-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={sending || draft.trim() === ''}>
            {sending ? 'Sending…' : 'Send message'}
          </button>
        </form>

        {confirmedBanner && (
          <div
            style={{
              background: 'var(--green-dim, rgba(39,174,96,0.08))',
              border: '1px solid rgba(39,174,96,0.3)',
              borderRadius: 'var(--radius-sm, 6px)',
              padding: '12px 14px',
              color: 'var(--green, #27ae60)',
              fontSize: '13px',
              marginTop: '12px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span style={{ fontSize: '16px' }}>✅</span>
            <span>
              <strong>Your availability has been confirmed.</strong>{' '}
              Blood Warriors will contact you shortly.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
