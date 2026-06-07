import { useEffect, useMemo, useState, useRef } from 'react';
import { 
  getPatients, 
  getReservations, 
  getBridgesByPatient, 
  getEscalationLog,
  postChat,
  getConversations,
  declareEmergency
} from '../api.js';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDate } from '../utils.js';

const BLOOD_TYPE_COLORS = {
  'A+': '#e53e3e',
  'A-': '#c53030',
  'B+': '#dd6b20',
  'B-': '#c05621',
  'AB+': '#805ad5',
  'AB-': '#6b46c1',
  'O+': '#38a169',
  'O-': '#276749',
};

const STAGE_LABELS = {
  outreach_stage_1: 'Stage 1 — Initial Contact',
  outreach_stage_2: 'Stage 2 — Follow-up',
  outreach_stage_3: 'Stage 3 — Escalation',
  donation_accepted: 'Donation Confirmed',
  sonar_ping: 'Sonar Availability Check',
  coordinator_message: 'Coordinator Message',
  emergency_declared: 'Emergency Declared',
};

const STAGE_COLORS = {
  outreach_stage_1: '#3182ce',
  outreach_stage_2: '#805ad5',
  outreach_stage_3: '#e53e3e',
  donation_accepted: '#38a169',
  sonar_ping: '#dd6b20',
  coordinator_message: '#718096',
  emergency_declared: '#e53e3e',
};

function daysUntil(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.round((date - today) / (1000 * 60 * 60 * 24));
}

const CopyButton = ({ text }) => {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button 
      onClick={handleCopy} 
      className="btn btn-ghost" 
      style={{ padding: '2px 6px', fontSize: '0.75rem', height: 'auto', border: 'none', background: 'transparent', marginLeft: '0.25rem' }}
      title="Copy full ID to clipboard"
    >
      {copied ? '✅' : '📋'}
    </button>
  );
};

function TimelineItem({ entry, isLast }) {
  const typeKey = entry.action_taken === 'emergency_declared' ? 'emergency_declared' : (entry.notification_type ?? entry.channel ?? 'coordinator_message');
  const color = STAGE_COLORS[typeKey] || '#718096';
  const label = STAGE_LABELS[typeKey] || typeKey;

  return (
    <div style={{ display: 'flex', gap: '1rem', position: 'relative' }}>
      {/* line */}
      {!isLast && (
        <div
          style={{
            position: 'absolute',
            left: '11px',
            top: '28px',
            bottom: '-8px',
            width: '2px',
            background: 'var(--border, #edf2f7)',
          }}
        />
      )}

      {/* dot */}
      <div
        style={{
          width: '24px',
          height: '24px',
          borderRadius: '50%',
          background: `${color}22`,
          border: `2px solid ${color}`,
          flexShrink: 0,
          marginTop: '2px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: color }} />
      </div>

      <div style={{ flex: 1, paddingBottom: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 700,
              background: `${color}22`,
              color,
              borderRadius: '20px',
              padding: '2px 8px',
              letterSpacing: '0.04em',
              textTransform: 'uppercase'
            }}
          >
            {label}
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-label, #718096)' }}>
            {formatDate(entry.sent_at ?? entry.timestamp ?? entry.trigger_date ?? entry.created_at)}
          </span>
        </div>
        {entry.outcome && (
          <p style={{ marginTop: '0.35rem', fontSize: '0.85rem', color: 'var(--text-body, #4a5568)', lineHeight: 1.5, margin: '4px 0 0' }}>
            {entry.outcome}
          </p>
        )}
        {entry.message && (
          <p style={{ marginTop: '0.35rem', fontSize: '0.85rem', color: 'var(--text-body, #4a5568)', lineHeight: 1.5, margin: '4px 0 0' }}>
            {entry.message}
          </p>
        )}
        {entry.donor_id && (
          <div style={{ fontSize: '0.72rem', color: 'var(--text-label, #718096)', marginTop: '0.2rem' }}>
            Donor: {entry.donor_id.slice(0, 18)}…
          </div>
        )}
      </div>
    </div>
  );
}

export function PatientDashboard() {
  const [patients, setPatients] = useState([]);
  const [selectedPatientId, setSelectedPatientId] = useState(null);
  const [reservations, setReservations] = useState([]);
  const [bridges, setBridges] = useState([]);
  const [escalation, setEscalation] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

  // Chat Drawer state
  const [chatDonorId, setChatDonorId] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  
  // Accordion state
  const [expandedBridges, setExpandedBridges] = useState({});

  // Request form state
  const [reqDate, setReqDate] = useState('');
  const [reqReason, setReqReason] = useState('scheduled_transfusion');
  const [reqSubmitting, setReqSubmitting] = useState(false);

  const { showToast } = useToast();
  const chatEndRef = useRef(null);

  // Load active patients list
  useEffect(() => {
    async function loadPatients() {
      try {
        const result = await getPatients({ status: 'active', limit: 100 });
        setPatients(Array.isArray(result) ? result : []);
        if (Array.isArray(result) && result.length > 0) {
          setSelectedPatientId(result[0].patient_id);
        }
      } catch (err) {
        setPatients([]);
      } finally {
        setLoading(false);
      }
    }
    loadPatients();
  }, []);

  // Reload patient details when selection changes
  const loadDetails = async () => {
    if (!selectedPatientId) return;
    setDetailLoading(true);
    try {
      const [reservationsResult, bridgesResult, escalationResult] = await Promise.all([
        getReservations({ patient_id: selectedPatientId }),
        getBridgesByPatient(selectedPatientId),
        getEscalationLog({ patient_id: selectedPatientId, limit: 30 }),
      ]);
      setReservations(Array.isArray(reservationsResult) ? reservationsResult : []);
      setBridges(Array.isArray(bridgesResult) ? bridgesResult : []);
      setEscalation(Array.isArray(escalationResult) ? escalationResult : []);
    } catch (err) {
      setReservations([]);
      setBridges([]);
      setEscalation([]);
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    loadDetails();
  }, [selectedPatientId]);

  const currentPatient = useMemo(() => {
    if (!Array.isArray(patients) || patients.length === 0) return null;
    return patients.find((p) => p.patient_id === selectedPatientId) || patients[0];
  }, [patients, selectedPatientId]);

  // Sync request date default picker value
  useEffect(() => {
    if (currentPatient?.expected_next_transfusion_date) {
      const d = new Date(currentPatient.expected_next_transfusion_date);
      if (!Number.isNaN(d.getTime())) {
        setReqDate(d.toISOString().split('T')[0]);
      }
    } else {
      setReqDate(new Date().toISOString().split('T')[0]);
    }
  }, [currentPatient]);

  // Scroll chat drawer to bottom on new messages
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isTyping]);

  const upcomingReservations = useMemo(
    () => reservations.filter((r) => r.status !== 'completed'),
    [reservations]
  );

  // Group bridges by bridge_id
  const groupedBridges = useMemo(() => {
    const groups = {};
    for (const b of bridges) {
      const gid = b.bridge_id || 'Unknown Bridge';
      if (!groups[gid]) {
        groups[gid] = {
          bridge_id: gid,
          blood_group: b.bridge_blood_group,
          status: b.status_of_bridge,
          donors: [],
          total_donations: 0
        };
      }
      groups[gid].donors.push(b);
      groups[gid].total_donations += (b.donations_till_date || 0);
    }
    return Object.values(groups);
  }, [bridges]);

  function shortId(id) {
    if (!id) return 'unknown';
    const str = String(id);
    return str.length > 12 ? str.substring(0, 12) : str;
  }

  // Load chat simulation history
  const openChatDrawer = async (donorId) => {
    setChatDonorId(donorId);
    setChatOpen(true);
    setChatLoading(true);
    setChatMessages([]);
    try {
      const history = await getConversations(donorId, selectedPatientId, 'patient');
      setChatMessages(Array.isArray(history?.history) ? history.history : []);
    } catch (err) {
      showToast('Could not load chat history.', 'error');
    } finally {
      setChatLoading(false);
    }
  };

  const handleSendMessage = async (msgText) => {
    if (!msgText.trim() || !chatDonorId || !selectedPatientId) return;
    
    const newMsg = {
      role: 'user',
      message: msgText,
      timestamp: new Date().toISOString()
    };
    
    setChatMessages((prev) => [...prev, newMsg]);
    setChatInput('');
    setIsTyping(true);

    try {
      const res = await postChat(chatDonorId, selectedPatientId, msgText, 'patient');
      if (res?.response) {
        setChatMessages((prev) => [
          ...prev, 
          {
            role: 'assistant',
            message: res.response,
            timestamp: new Date().toISOString()
          }
        ]);
      } else {
        showToast('No response received from donor.', 'warning');
      }
    } catch (err) {
      showToast('Failed to deliver message.', 'error');
    } finally {
      setIsTyping(false);
    }
  };

  const handleSendThankYou = async (donorId) => {
    const thankYouMsg = "Thank you so much for being one of my bridge donors! I really appreciate your support.";
    await openChatDrawer(donorId);
    setTimeout(() => {
      handleSendMessage(thankYouMsg);
    }, 500);
  };

  const handleRequestTransfusion = async (e) => {
    e.preventDefault();
    if (!selectedPatientId) return;
    
    setReqSubmitting(true);
    try {
      const reasonLabel = reqReason === 'scheduled_transfusion' ? 'Scheduled Transfusion' : reqReason === 'emergency_surgery' ? 'Emergency Surgery' : 'Low Blood Count Alert';
      const reasonText = `${reasonLabel} requested on ${reqDate}`;
      
      const res = await declareEmergency(selectedPatientId, reqDate, reasonText);
      if (res?.success || res?.logged) {
        showToast('Transfusion request declared successfully! Coordinator notified.', 'success');
        // Refresh details
        await loadDetails();
      } else {
        showToast('Request declaration failed.', 'error');
      }
    } catch (err) {
      showToast('Error declaring transfusion request.', 'error');
    } finally {
      setReqSubmitting(false);
    }
  };

  const toggleGroupExpand = (bridgeId) => {
    setExpandedBridges((s) => ({ ...s, [bridgeId]: !s[bridgeId] }));
  };

  if (loading) return <LoadingSpinner label="Loading patient dashboard" />;

  if (!currentPatient || !patients.length) {
    return <EmptyState title="No patient available" message="This portal requires a patient profile." />;
  }

  const bloodColor = BLOOD_TYPE_COLORS[currentPatient.blood_group] || '#e53e3e';
  const daysLeft = daysUntil(currentPatient.expected_next_transfusion_date);
  
  // Urgent alerts styling
  const urgLabel = daysLeft === null ? 'STABLE' : daysLeft <= 0 ? 'OVERDUE' : daysLeft <= 3 ? 'CRITICAL' : daysLeft <= 7 ? 'URGENT' : 'STABLE';
  const urgBadgeClass = urgLabel === 'OVERDUE' || urgLabel === 'CRITICAL' ? 'badge-danger' : urgLabel === 'URGENT' ? 'badge-warning' : 'badge-success';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

      {/* Patient selector */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Patient Portal</h2>
            <small>Manage blood matches, request history, and direct outreach updates.</small>
          </div>
          <div style={{ width: '280px' }}>
            <select
              id="patient-select"
              value={selectedPatientId || ''}
              onChange={(e) => setSelectedPatientId(e.target.value)}
              style={{ padding: '8px 12px', fontSize: '0.9rem' }}
            >
              {Array.isArray(patients) && patients.length > 0
                ? patients.map((patient, index) => (
                    <option key={patient.patient_id} value={patient.patient_id}>
                      Patient {index + 1} — {patient.blood_group || 'Unknown'}
                    </option>
                  ))
                : null}
            </select>
          </div>
        </div>
      </div>

      {/* Overview Banner */}
      <div
        className="card"
        style={{
          borderLeft: `5px solid ${bloodColor}`,
          background: 'var(--white)',
          boxShadow: 'var(--shadow)',
          borderRadius: 'var(--radius)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '2rem',
          padding: '1.5rem',
          alignItems: 'center',
        }}
      >
        {/* Blood drop icon */}
        <div
          style={{
            width: '68px',
            height: '68px',
            borderRadius: '50%',
            background: `${bloodColor}12`,
            border: `3px solid ${bloodColor}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 800,
            fontSize: '1.25rem',
            color: bloodColor,
            flexShrink: 0,
            boxShadow: '0 2px 8px rgba(0,0,0,0.05)'
          }}
        >
          {currentPatient.blood_group || '?'}
        </div>

        <div style={{ flex: 1, minWidth: '200px' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text-heading)' }}>
            Patient ID Overview
          </h3>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-label)', fontFamily: 'monospace', background: '#f1f5f9', padding: '3px 8px', borderRadius: '4px', border: '1px solid var(--border)', display: 'inline-block', marginTop: '0.35rem' }}>
            {currentPatient.patient_id}
            <CopyButton text={currentPatient.patient_id} />
          </span>
        </div>

        <div style={{ display: 'flex', gap: '2.5rem', flexWrap: 'wrap' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-label)', textTransform: 'uppercase', fontWeight: 600 }}>Portal Status</div>
            <span className="badge badge-success" style={{ marginTop: '6px' }}>{currentPatient.status || 'Active'}</span>
          </div>

          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-label)', textTransform: 'uppercase', fontWeight: 600 }}>Next Transfusion</div>
            <div style={{ marginTop: '6px', fontSize: '0.9rem', fontWeight: 700 }}>
              {formatDate(currentPatient.expected_next_transfusion_date) || '—'}
            </div>
          </div>

          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-label)', textTransform: 'uppercase', fontWeight: 600 }}>Transfusion Urgency</div>
            <div style={{ marginTop: '4px' }}>
              <span className={`badge ${urgBadgeClass}`} style={{ fontWeight: 700 }}>
                {urgLabel === 'STABLE' ? 'STABLE' : daysLeft === 0 ? 'OVERDUE TODAY' : `${urgLabel} (${daysLeft}d left)`}
              </span>
            </div>
          </div>

          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-label)', textTransform: 'uppercase', fontWeight: 600 }}>Bridges Count</div>
            <div style={{ marginTop: '4px', fontSize: '1.25rem', fontWeight: 800, color: '#805ad5' }}>
              {bridges.length}
            </div>
          </div>
        </div>
      </div>

      {/* Grid: Action Center & Timeline */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem' }}>
        
        {/* Action Center - Urgent Blood Request & Prep */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.05rem', color: 'var(--text-heading)' }}>🩸 Transfusion Request &amp; Preparation</h3>
            <small>Notify your coordinator of your upcoming schedule to trigger emergency escalations.</small>
          </div>

          {/* Reserved Donors List */}
          <div style={{ background: '#f8fafc', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border)' }}>
            <h4 style={{ fontSize: '0.85rem', color: 'var(--text-label)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 0.5rem 0' }}>
              🎯 Upcoming Transfusion Donor Reserves ({upcomingReservations.length})
            </h4>
            {upcomingReservations.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {upcomingReservations.map((resv) => (
                  <div 
                    key={resv.id ?? resv.reservation_id}
                    style={{ background: 'white', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                  >
                    <div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 600, fontFamily: 'monospace' }}>
                        Donor {shortId(resv.donor_id)}
                      </div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-label)' }}>
                        Date: {resv.transfusion_date ? new Date(resv.transfusion_date).toLocaleDateString() : '—'}
                      </div>
                    </div>
                    <span className="badge badge-success" style={{ fontSize: '0.7rem', padding: '2px 8px' }}>
                      {resv.status || 'reserved'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-label)', fontStyle: 'italic' }}>
                No active donor reservations matching your schedule yet. Declare your request below.
              </p>
            )}
          </div>

          {/* Quick Request Form */}
          <form onSubmit={handleRequestTransfusion} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div>
                <label className="form-label" style={{ fontSize: '0.8rem', fontWeight: 600 }}>Transfusion Date</label>
                <input 
                  type="date" 
                  value={reqDate}
                  onChange={(e) => setReqDate(e.target.value)}
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                  required
                />
              </div>
              <div>
                <label className="form-label" style={{ fontSize: '0.8rem', fontWeight: 600 }}>Urgency Context</label>
                <select
                  value={reqReason}
                  onChange={(e) => setReqReason(e.target.value)}
                  style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                >
                  <option value="scheduled_transfusion">Scheduled Transfusion</option>
                  <option value="emergency_surgery">Emergency Surgery</option>
                  <option value="low_blood_count">Low Blood Count Alert</option>
                </select>
              </div>
            </div>
            <button 
              type="submit" 
              className="btn btn-primary btn-sm" 
              style={{ width: '100%', padding: '8px' }}
              disabled={reqSubmitting}
            >
              {reqSubmitting ? 'Submitting Request...' : '🚨 Declare Blood Request'}
            </button>
          </form>
        </div>

        {/* Request Status Timeline */}
        <div className="card">
          <h3 style={{ margin: '0 0 1rem', fontSize: '1.05rem', color: 'var(--text-heading)' }}>
            📋 Request Status Timeline
          </h3>
          
          {detailLoading ? (
            <LoadingSpinner label="Loading timeline..." />
          ) : escalation.length > 0 ? (
            <div style={{ maxHeight: '310px', overflowY: 'auto', paddingRight: '0.5rem' }}>
              {escalation.map((entry, idx) => (
                <TimelineItem 
                  key={entry.id ?? idx} 
                  entry={entry} 
                  isLast={idx === escalation.length - 1} 
                />
              ))}
            </div>
          ) : (
            <div style={{ padding: '2rem 1rem', textAlign: 'center', background: '#f8fafc', borderRadius: '8px', border: '1px dashed var(--border)' }}>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-label)', fontStyle: 'italic' }}>
                No escalation log or outreach history recorded yet.
              </p>
            </div>
          )}
        </div>

      </div>

      {/* Accordion Bridge Donors Groups */}
      <div className="card">
        <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.1rem', color: 'var(--text-heading)' }}>
          🩸 Your Donor Bridge Groups
        </h3>
        <p style={{ margin: '0 0 1.25rem 0', fontSize: '0.82rem', color: 'var(--text-label)' }}>
          Grouped by Bridge Network ID. Click a bridge group to see your assigned donors, thank them, or chat with them.
        </p>

        {detailLoading ? (
          <LoadingSpinner label="Loading assigned bridges..." />
        ) : groupedBridges.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {groupedBridges.map((group, idx) => {
              const isExpanded = !!expandedBridges[group.bridge_id];
              return (
                <div 
                  key={group.bridge_id}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    background: 'white',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.02)'
                  }}
                >
                  {/* Accordion Header */}
                  <div 
                    onClick={() => toggleGroupExpand(group.bridge_id)}
                    style={{
                      padding: '1rem 1.25rem',
                      background: isExpanded ? '#f8fafc' : 'white',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '1rem',
                      borderBottom: isExpanded ? '1px solid var(--border)' : 'none',
                      transition: 'background 0.2s'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <span style={{ fontSize: '1.15rem' }}>🌉</span>
                      <div>
                        <strong style={{ fontSize: '0.92rem', color: 'var(--text-heading)' }}>
                          Bridge Group #{shortId(group.bridge_id)}
                        </strong>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-label)', marginTop: '0.15rem' }}>
                          ID: <span style={{ fontFamily: 'monospace' }}>{group.bridge_id}</span>
                          <CopyButton text={group.bridge_id} />
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
                      <div>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-label)' }}>Members:</span>{' '}
                        <strong style={{ fontSize: '0.85rem' }}>{group.donors.length}</strong>
                      </div>
                      <div>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-label)' }}>Total Contributions:</span>{' '}
                        <strong style={{ fontSize: '0.85rem', color: 'var(--green)' }}>{group.total_donations} unit(s)</strong>
                      </div>
                      <span className="badge badge-success" style={{ background: '#e8f5e9', color: '#27ae60', fontSize: '0.7rem' }}>
                        Active Group
                      </span>
                      <button 
                        className="btn btn-ghost" 
                        style={{ border: 'none', background: 'transparent', padding: '4px 8px', fontSize: '0.9rem' }}
                      >
                        {isExpanded ? '▲' : '▼'}
                      </button>
                    </div>
                  </div>

                  {/* Accordion Body */}
                  {isExpanded && (
                    <div style={{ padding: '1.25rem', background: '#fafbfc' }}>
                      <table className="table" style={{ width: '100%', borderCollapse: 'collapse', background: 'white', border: '1px solid var(--border)', borderRadius: '6px' }}>
                        <thead>
                          <tr style={{ background: '#f8fafc', borderBottom: '1px solid var(--border)' }}>
                            <th style={{ padding: '10px 12px', fontSize: '0.8rem', textAlign: 'left', color: 'var(--text-label)' }}>Donor ID</th>
                            <th style={{ padding: '10px 12px', fontSize: '0.8rem', textAlign: 'left', color: 'var(--text-label)' }}>Group Blood</th>
                            <th style={{ padding: '10px 12px', fontSize: '0.8rem', textAlign: 'left', color: 'var(--text-label)' }}>Donations Provided</th>
                            <th style={{ padding: '10px 12px', fontSize: '0.8rem', textAlign: 'left', color: 'var(--text-label)' }}>Last Donation</th>
                            <th style={{ padding: '10px 12px', fontSize: '0.8rem', textAlign: 'right', color: 'var(--text-label)' }}>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.donors.map((d) => (
                            <tr key={d.donor_id} style={{ borderBottom: '1px solid var(--border)' }}>
                              <td style={{ padding: '12px', fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 600 }}>
                                {shortId(d.donor_id)}
                                <CopyButton text={d.donor_id} />
                              </td>
                              <td style={{ padding: '12px' }}>
                                <span style={{ background: `${BLOOD_TYPE_COLORS[d.bridge_blood_group] || '#e53e3e'}12`, color: BLOOD_TYPE_COLORS[d.bridge_blood_group] || '#e53e3e', padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 700 }}>
                                  {d.bridge_blood_group}
                                </span>
                              </td>
                              <td style={{ padding: '12px', fontWeight: 600 }}>{d.donations_till_date ?? 0} unit(s)</td>
                              <td style={{ padding: '12px', fontSize: '0.8rem' }}>
                                {d.last_bridge_donation_date ? new Date(d.last_bridge_donation_date).toLocaleDateString() : '—'}
                              </td>
                              <td style={{ padding: '12px', textAlign: 'right' }}>
                                <div style={{ display: 'inline-flex', gap: '0.5rem' }}>
                                  <button 
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => handleSendThankYou(d.donor_id)}
                                    style={{ fontSize: '0.75rem', padding: '4px 8px', border: '1px solid var(--border)' }}
                                    title="Send a quick thank you message"
                                  >
                                    ❤️ Thank
                                  </button>
                                  <button 
                                    className="btn btn-primary btn-sm"
                                    onClick={() => openChatDrawer(d.donor_id)}
                                    style={{ fontSize: '0.75rem', padding: '4px 10px', background: 'var(--accent)' }}
                                  >
                                    💬 Chat
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="No bridge donors matched yet"
            message="Your coordinator is mapping your bridge donor groups. They will appear here once connected."
          />
        )}
      </div>

      {/* Interactive AI Chat Drawer */}
      <div className={`drawer-backdrop ${chatOpen ? 'open' : ''}`} onClick={() => setChatOpen(false)}>
        <div 
          className="drawer" 
          style={{ right: chatOpen ? 0 : '-420px', width: '420px', display: 'flex', flexDirection: 'column', background: 'white' }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Drawer Header */}
          <div className="drawer-head" style={{ borderBottom: '1px solid var(--border)', padding: '1.25rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.05rem', color: 'var(--text-heading)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                💬 Chat with Donor
              </h3>
              <small style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-label)' }}>
                ID: {shortId(chatDonorId)}
                <CopyButton text={chatDonorId} />
              </small>
            </div>
            <button 
              className="btn btn-ghost btn-sm" 
              style={{ border: 'none', fontSize: '1.1rem', fontWeight: 'bold' }}
              onClick={() => setChatOpen(false)}
            >
              ×
            </button>
          </div>

          {/* Messages List */}
          <div 
            className="drawer-body" 
            style={{ 
              flex: 1, 
              overflowY: 'auto', 
              padding: '1.25rem', 
              background: '#f8fafc',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem'
            }}
          >
            {chatLoading ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: '0.5rem', color: 'var(--text-label)' }}>
                <div className="spinner"></div>
                <span>Retrieving conversation log...</span>
              </div>
            ) : chatMessages.length === 0 ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', padding: '2rem', textAlign: 'center', color: 'var(--text-label)' }}>
                <span style={{ fontSize: '2rem' }}>👋</span>
                <strong style={{ fontSize: '0.9rem', color: 'var(--text-heading)', marginTop: '0.5rem' }}>Send a welcome message!</strong>
                <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.8rem' }}>Initiate chat with this donor to confirm schedules or express appreciation.</p>
              </div>
            ) : (
              chatMessages.map((msg, idx) => {
                const isPatient = msg.role === 'user';
                return (
                  <div 
                    key={idx}
                    style={{
                      alignSelf: isPatient ? 'flex-end' : 'flex-start',
                      maxWidth: '85%',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: isPatient ? 'flex-end' : 'flex-start'
                    }}
                  >
                    <div style={{
                      padding: '10px 14px',
                      borderRadius: isPatient ? '14px 14px 2px 14px' : '14px 14px 14px 2px',
                      background: isPatient ? 'var(--accent)' : 'white',
                      color: isPatient ? 'white' : 'var(--text-body)',
                      fontSize: '0.88rem',
                      lineHeight: '1.45',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
                      border: isPatient ? 'none' : '1px solid var(--border)'
                    }}>
                      {msg.message}
                    </div>
                    <small style={{ fontSize: '0.68rem', color: 'var(--text-label)', marginTop: '2px', padding: '0 2px' }}>
                      {msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                    </small>
                  </div>
                );
              })
            )}

            {isTyping && (
              <div style={{ alignSelf: 'flex-start', background: 'white', padding: '10px 14px', borderRadius: '12px', border: '1px solid var(--border)', fontSize: '0.82rem', color: 'var(--text-label)' }}>
                <span className="spinner" style={{ marginRight: '6px', width: '12px', height: '12px' }}></span>
                Donor is typing reply...
              </div>
            )}
            
            <div ref={chatEndRef} />
          </div>

          {/* Quick suggestions */}
          <div style={{ padding: '0.5rem 1rem', background: '#f1f5f9', display: 'flex', gap: '0.35rem', overflowX: 'auto', whiteSpace: 'nowrap', borderTop: '1px solid var(--border)' }}>
            {[
              "Hello, checking in on your availability!",
              "Are you available for donation next week?",
              "Thank you so much for your support! ❤️"
            ].map((sug) => (
              <button
                key={sug}
                onClick={() => handleSendMessage(sug)}
                className="btn btn-sm btn-ghost"
                style={{ 
                  fontSize: '0.72rem', 
                  padding: '4px 8px', 
                  borderRadius: '16px', 
                  background: 'white', 
                  border: '1px solid var(--border)',
                  whiteSpace: 'nowrap',
                  cursor: 'pointer'
                }}
              >
                {sug}
              </button>
            ))}
          </div>

          {/* Chat input footer */}
          <div style={{ padding: '1rem', borderTop: '1px solid var(--border)', background: 'white' }}>
            <form 
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage(chatInput);
              }}
              style={{ display: 'flex', gap: '0.5rem' }}
            >
              <input 
                type="text" 
                className="input" 
                placeholder="Type your message to donor..." 
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                style={{ flex: 1, fontSize: '0.9rem', padding: '8px 12px' }}
                disabled={isTyping}
              />
              <button 
                type="submit" 
                className="btn btn-primary"
                style={{ padding: '8px 16px', background: 'var(--accent)' }}
                disabled={isTyping || !chatInput.trim()}
              >
                Send
              </button>
            </form>
          </div>

        </div>
      </div>

    </div>
  );
}
