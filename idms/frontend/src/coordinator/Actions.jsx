import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import {
  getPatients,
  getRankedDonors,
  postOutreach,
  getConversations,
  getNotificationsLog,
  postReserve,
  postSaveMessage,
  postNotifyDonor,
  getPendingHandoffs,
} from '../api.js';
import { CoordinatorChat } from './CoordinatorChat.jsx';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import { useToast } from '../components/Toast.jsx';

// ─── Helpers ────────────────────────────────────────────────────────────────

function daysUntil(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.round((date - today) / (1000 * 60 * 60 * 24));
}

function timeAgo(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function dayColor(days) {
  if (days == null) return '#718096';
  if (days <= 3) return '#c53030';
  if (days <= 7) return '#f39c12';
  return '#27ae60';
}

function stageColor(stage) {
  if (stage === 1) return { bg: '#e8f5e9', color: '#27ae60', label: 'Stage 1' };
  if (stage === 2) return { bg: '#fef5e7', color: '#f39c12', label: 'Stage 2' };
  if (stage === 3) return { bg: '#fee', color: '#c53030', label: 'Stage 3' };
  return { bg: '#f0f4f8', color: '#718096', label: '—' };
}

function isPositiveResponse(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return /\b(yes|haan|available|ready|ok|sure|confirm|ha|agree|will)\b/.test(t);
}

function extractStageFromType(notifType) {
  if (!notifType) return null;
  const m = notifType.match(/outreach_stage_(\d)/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Spinner inline ──────────────────────────────────────────────────────────
function Spin() {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 14,
        height: 14,
        border: '2px solid #ccc',
        borderTopColor: 'var(--accent)',
        borderRadius: '50%',
        animation: 'spin 0.6s linear infinite',
        verticalAlign: 'middle',
      }}
    />
  );
}

// ─── Main component ─────────────────────────────────────────────────────────
export function CoordinatorActions() {
  const { showToast } = useToast();

  // ── patient data ──
  const [patients, setPatients] = useState([]);
  const [patientsLoading, setPatientsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedPatientId, setSelectedPatientId] = useState('');
  const searchRef = useRef(null);

  // ── ranked donors ──
  const [rankedDonors, setRankedDonors] = useState([]);
  const [donorsLoading, setDonorsLoading] = useState(false);
  const [contactedDonors, setContactedDonors] = useState(new Set());

  // ── outreach stage results ──
  const [stageResults, setStageResults] = useState({ 1: null, 2: null, 3: null });
  const [stageLoading, setStageLoading] = useState({ 1: false, 2: false, 3: false });

  // ── notifications log / response tracker ──
  const [notifications, setNotifications] = useState([]);
  const [notifsLoading, setNotifsLoading] = useState(false);
  const pollRef = useRef(null);

  // ── chat drawer ──
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerDonorId, setDrawerDonorId] = useState(null);
  const [drawerPatientId, setDrawerPatientId] = useState(null);
  const [drawerHistory, setDrawerHistory] = useState([]);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [drawerInput, setDrawerInput] = useState('');
  const [drawerSending, setDrawerSending] = useState(false);
  const chatEndRef = useRef(null);

  // ── coordinator handoff queue ──
  const [pendingHandoffs, setPendingHandoffs] = useState([]);
  const [activeHandoff, setActiveHandoff] = useState(null);

  // ── derived ──
  const selectedPatient = useMemo(
    () => patients.find((p) => p.patient_id === selectedPatientId) || null,
    [patients, selectedPatientId]
  );

  const filteredPatients = useMemo(() => {
    if (!searchQuery.trim()) return patients;
    const q = searchQuery.toLowerCase();
    return patients.filter(
      (p) =>
        p.patient_id?.toLowerCase().includes(q) ||
        p.blood_group?.toLowerCase().includes(q)
    );
  }, [patients, searchQuery]);

  // ── load patients ──
  useEffect(() => {
    async function load() {
      setPatientsLoading(true);
      try {
        const data = await getPatients({ limit: 1000 });
        const arr = Array.isArray(data) ? data : [];
        setPatients(arr);
        if (arr.length > 0 && !selectedPatientId) {
          setSelectedPatientId(arr[0].patient_id);
        }
      } catch (err) {
        showToast(`Failed to load patients: ${err.message}`, 'error');
      } finally {
        setPatientsLoading(false);
      }
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── load ranked donors when patient changes ──
  useEffect(() => {
    if (!selectedPatientId) {
      setRankedDonors([]);
      return;
    }
    async function load() {
      setDonorsLoading(true);
      try {
        const data = await getRankedDonors(selectedPatientId);
        setRankedDonors(Array.isArray(data) ? data : []);
      } catch (err) {
        setRankedDonors([]);
        showToast(`Could not load ranked donors: ${err.message}`, 'error');
      } finally {
        setDonorsLoading(false);
      }
    }
    load();
    setContactedDonors(new Set());
    setStageResults({ 1: null, 2: null, 3: null });
    setNotifications([]);
  }, [selectedPatientId]);

  // ── poll notifications log ──
  const loadNotifications = useCallback(async () => {
    if (!selectedPatientId) return;
    setNotifsLoading(true);
    try {
      const data = await getNotificationsLog(null, { patient_id: selectedPatientId, limit: 50 });
      setNotifications(Array.isArray(data) ? data : []);
    } catch (err) {
      // silently fail poll
    } finally {
      setNotifsLoading(false);
    }
  }, [selectedPatientId]);

  useEffect(() => {
    if (!selectedPatientId) return;
    loadNotifications();
    pollRef.current = setInterval(loadNotifications, 20000);
    return () => clearInterval(pollRef.current);
  }, [selectedPatientId, loadNotifications]);

  // ── poll handoff queue every 10s ──
  const fetchHandoffs = useCallback(async () => {
    const data = await getPendingHandoffs();
    setPendingHandoffs(data);
  }, []);

  useEffect(() => {
    fetchHandoffs();
    const interval = setInterval(fetchHandoffs, 10000);
    return () => clearInterval(interval);
  }, [fetchHandoffs]);

  // ── close search dropdown on outside click ──
  useEffect(() => {
    function handler(e) {
      if (searchRef.current && !searchRef.current.contains(e.target)) {
        setSearchOpen(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── drawer history ──
  useEffect(() => {
    if (!drawerOpen || !drawerDonorId) {
      setDrawerHistory([]);
      return;
    }
    let active = true;
    async function fetchHistory() {
      setDrawerLoading(true);
      try {
        const res = await getConversations(drawerDonorId, drawerPatientId || selectedPatientId);
        if (active) setDrawerHistory(res?.history || []);
      } catch {
        /* silent */
      } finally {
        if (active) setDrawerLoading(false);
      }
    }
    fetchHistory();
    return () => { active = false; };
  }, [drawerOpen, drawerDonorId, drawerPatientId, selectedPatientId]);

  useEffect(() => {
    if (chatEndRef.current) chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [drawerHistory]);

  // ── handlers ──
  function selectPatient(id) {
    setSelectedPatientId(id);
    setSearchOpen(false);
    setSearchQuery('');
  }

  async function handleSendOutreach(donorId) {
    try {
      await postNotifyDonor(donorId, selectedPatientId, 'Outreach sent by coordinator', 1);
      showToast('Outreach sent to donor', 'success');
      setContactedDonors((prev) => new Set([...prev, donorId]));
    } catch (err) {
      showToast(`Failed to send outreach: ${err?.response?.data?.detail || err.message}`, 'error');
    }
  }

  async function handleStageOutreach(stage) {
    if (!selectedPatientId) return;
    setStageLoading((prev) => ({ ...prev, [stage]: true }));
    try {
      const res = await postOutreach(selectedPatientId, stage, 'en', false);
      setStageResults((prev) => ({ ...prev, [stage]: res }));
      showToast(`Stage ${stage} outreach sent`, 'success');
      setTimeout(loadNotifications, 1000);
    } catch (err) {
      const detail = err?.response?.data?.error || err?.response?.data?.detail || err.message;
      showToast(`Stage ${stage} outreach failed: ${detail}`, 'error');
    } finally {
      setStageLoading((prev) => ({ ...prev, [stage]: false }));
    }
  }

  function openChat(donorId, patientId) {
    setDrawerDonorId(donorId);
    setDrawerPatientId(patientId || selectedPatientId);
    setDrawerOpen(true);
  }

  async function handleDrawerSend(e) {
    if (e) e.preventDefault();
    if (!drawerInput.trim() || drawerSending) return;
    setDrawerSending(true);
    const msg = drawerInput;
    setDrawerInput('');
    try {
      await postSaveMessage(drawerDonorId, drawerPatientId || selectedPatientId, msg, 'assistant');
      await postNotifyDonor(drawerDonorId, drawerPatientId || selectedPatientId, msg, 1);
      const updated = await getConversations(drawerDonorId, drawerPatientId || selectedPatientId);
      setDrawerHistory(updated?.history || []);
    } catch (err) {
      showToast(`Failed to send message: ${err.message}`, 'error');
      setDrawerInput(msg);
    } finally {
      setDrawerSending(false);
    }
  }

  async function handleReserve(donorId, patientId) {
    const transfusionDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    try {
      await postReserve(donorId, patientId || selectedPatientId, transfusionDate);
      showToast('Blood reserved successfully', 'success');
    } catch (err) {
      const detail = err?.response?.data?.detail || err.message;
      showToast(`Reserve failed: ${detail}`, 'error');
    }
  }

  // ── derived notification sets ──
  const outreachNotifs = useMemo(
    () => notifications.filter((n) => n.notification_type?.includes('outreach')),
    [notifications]
  );
  const respondedNotifs = useMemo(
    () => notifications.filter((n) => n.response != null && n.response !== ''),
    [notifications]
  );

  // ─── RENDER ───────────────────────────────────────────────────────────────

  if (patientsLoading) {
    return <LoadingSpinner label="Loading coordinator actions…" />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* ── Coordinator Chat Drawer (handoff) ── */}
      {activeHandoff && (
        <CoordinatorChat
          handoff={activeHandoff}
          onClose={() => {
            setActiveHandoff(null);
            fetchHandoffs();
          }}
        />
      )}

      {/* ── HANDOFF ALERT QUEUE ── show at the very top if any pending ── */}
      {pendingHandoffs.length > 0 && (
        <div style={{
          background: 'linear-gradient(135deg, rgba(128,90,213,0.13), rgba(128,90,213,0.04))',
          border: '1.5px solid rgba(128,90,213,0.5)',
          borderRadius: '12px',
          padding: '1.1rem 1.4rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.85rem' }}>
            <span style={{ fontSize: '1.3rem' }}>🔔</span>
            <div style={{ flex: 1 }}>
              <span style={{ fontWeight: 700, color: '#9f7aea', fontSize: '1rem' }}>
                {pendingHandoffs.length} Donor{pendingHandoffs.length > 1 ? 's' : ''} Waiting — Coordinator Needed
              </span>
              <div style={{ fontSize: '0.76rem', opacity: 0.65, marginTop: 1 }}>
                AI is paused for these conversations. Click "Take Over" to chat directly.
              </div>
            </div>
            <span style={{
              background: '#805ad5', color: '#fff',
              borderRadius: '999px', padding: '2px 12px',
              fontWeight: 700, fontSize: '0.8rem',
            }}>
              {pendingHandoffs.length} pending
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {pendingHandoffs.map((h) => {
              const elapsed = h.flagged_at
                ? Math.round((Date.now() - new Date(h.flagged_at).getTime()) / 60000)
                : null;
              return (
                <div key={`${h.donor_id}-${h.patient_id}`} style={{
                  background: 'rgba(128,90,213,0.08)',
                  border: '1px solid rgba(128,90,213,0.22)',
                  borderRadius: '9px',
                  padding: '0.75rem 1rem',
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: '0.75rem',
                }}>
                  <div style={{ flex: '1 1 180px' }}>
                    <div style={{ fontSize: '0.82rem', fontWeight: 700, display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <span>🩸 Donor: <code style={{ fontSize: '0.74rem' }}>{h.donor_id?.slice(0, 16)}…</code></span>
                      <span style={{ opacity: 0.4 }}>·</span>
                      <span>🏥 Patient: <code style={{ fontSize: '0.74rem' }}>{h.patient_id?.slice(0, 14)}…</code></span>
                    </div>
                    {h.donor_message && (
                      <div style={{ fontSize: '0.76rem', color: '#9f7aea', marginTop: 3 }}>
                        💬 <em>"{h.donor_message.length > 90 ? h.donor_message.slice(0, 90) + '…' : h.donor_message}"</em>
                      </div>
                    )}
                    {elapsed !== null && (
                      <div style={{ fontSize: '0.7rem', opacity: 0.45, marginTop: 2 }}>
                        ⏱ {elapsed < 1 ? 'just now' : `${elapsed} min ago`}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => setActiveHandoff(h)}
                    style={{
                      background: '#805ad5', color: '#fff',
                      border: 'none', borderRadius: '8px',
                      padding: '7px 16px', fontWeight: 700,
                      fontSize: '0.82rem', cursor: 'pointer',
                      boxShadow: '0 2px 8px rgba(128,90,213,0.35)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    💬 Take Over
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── PAGE HEADER ── */}
      <div className="card" style={{ padding: '20px 24px' }}>
        <h2 style={{ margin: '0 0 4px 0', fontSize: '1.4rem' }}>Coordinator Outreach</h2>
        <p style={{ margin: 0, color: 'var(--text-label)', fontSize: '0.9rem' }}>
          Select a patient, rank donors, trigger outreach by stage, and track responses.
        </p>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 1 — PATIENT SEARCH
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="card">
        <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem', textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-label)' }}>
          Patient Search
        </h3>

        {/* Search bar */}
        <div ref={searchRef} style={{ position: 'relative', marginBottom: '16px' }}>
          <input
            type="text"
            placeholder="Search patient by ID or blood group…"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setSearchOpen(true); }}
            onFocus={() => setSearchOpen(true)}
            style={{
              width: '100%',
              padding: '10px 14px',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              fontSize: '0.95rem',
              outline: 'none',
              background: 'var(--white)',
            }}
          />

          {/* Dropdown */}
          {searchOpen && filteredPatients.length > 0 && (
            <div style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              right: 0,
              background: 'var(--white)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
              zIndex: 50,
              maxHeight: 260,
              overflowY: 'auto',
            }}>
              {filteredPatients.slice(0, 20).map((p) => {
                const days = daysUntil(p.expected_next_transfusion_date);
                const color = dayColor(days);
                return (
                  <div
                    key={p.patient_id}
                    onClick={() => selectPatient(p.patient_id)}
                    style={{
                      padding: '10px 14px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      borderBottom: '1px solid var(--border)',
                      background: p.patient_id === selectedPatientId ? 'var(--bg-light)' : 'var(--white)',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-light)'}
                    onMouseLeave={(e) => e.currentTarget.style.background = p.patient_id === selectedPatientId ? 'var(--bg-light)' : 'var(--white)'}
                  >
                    <span style={{
                      background: '#fee',
                      color: '#c53030',
                      padding: '2px 8px',
                      borderRadius: 999,
                      fontSize: '0.78rem',
                      fontWeight: 600,
                    }}>
                      {p.blood_group || '?'}
                    </span>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.85rem', flex: 1 }}>
                      {p.patient_id}
                    </span>
                    {days != null && (
                      <span style={{ color, fontWeight: 600, fontSize: '0.85rem' }}>
                        {days}d
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Patient cards grid */}
        {!searchQuery && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
            {patients.slice(0, 12).map((p) => {
              const days = daysUntil(p.expected_next_transfusion_date);
              const color = dayColor(days);
              const selected = p.patient_id === selectedPatientId;
              return (
                <div
                  key={p.patient_id}
                  onClick={() => selectPatient(p.patient_id)}
                  style={{
                    padding: '12px 14px',
                    border: `2px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 'var(--radius)',
                    cursor: 'pointer',
                    background: selected ? '#fff5f5' : 'var(--white)',
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-label)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.patient_id}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <span style={{ background: '#fee', color: '#c53030', padding: '2px 8px', borderRadius: 999, fontSize: '0.8rem', fontWeight: 600 }}>
                      {p.blood_group || '?'}
                    </span>
                    {days != null && (
                      <span style={{ color, fontWeight: 700, fontSize: '0.95rem' }}>{days}d</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 2 — SELECTED PATIENT DETAIL
      ══════════════════════════════════════════════════════════════════════ */}
      {selectedPatient && (() => {
        const days = daysUntil(selectedPatient.expected_next_transfusion_date);
        const color = dayColor(days);
        return (
          <div className="card" style={{ borderLeft: `4px solid ${color}` }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-label)', marginBottom: 2 }}>PATIENT ID</div>
                <code style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>
                  {selectedPatient.patient_id.slice(0, 20)}…
                </code>
              </div>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-label)', marginBottom: 2 }}>BLOOD GROUP</div>
                <span style={{ background: '#fee', color: '#c53030', padding: '4px 12px', borderRadius: 999, fontWeight: 700, fontSize: '0.9rem' }}>
                  {selectedPatient.blood_group || 'Unknown'}
                </span>
              </div>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-label)', marginBottom: 2 }}>DAYS UNTIL TRANSFUSION</div>
                <span style={{ color, fontSize: '1.75rem', fontWeight: 800, lineHeight: 1 }}>
                  {days != null ? days : '—'}
                </span>
              </div>
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-label)', marginBottom: 2 }}>FREQUENCY</div>
                <span style={{ fontWeight: 600 }}>
                  Every {selectedPatient.frequency_in_days || '?'} days
                </span>
              </div>
              <div style={{ marginLeft: 'auto' }}>
                <span style={{
                  background: days != null && days <= 3 ? '#fee' : days != null && days <= 7 ? '#fef5e7' : '#e8f5e9',
                  color: days != null && days <= 3 ? '#c53030' : days != null && days <= 7 ? '#f39c12' : '#27ae60',
                  padding: '6px 14px',
                  borderRadius: 999,
                  fontWeight: 700,
                  fontSize: '0.85rem',
                }}>
                  {days != null && days <= 3 ? '🚨 Critical' : days != null && days <= 7 ? '⚠️ Urgent' : '✅ Stable'}
                </span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 3 — RANKED DONORS TABLE
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{ margin: 0 }}>
            Ranked Donors
            {selectedPatient?.blood_group && (
              <span style={{ marginLeft: 10, background: '#fee', color: '#c53030', padding: '2px 10px', borderRadius: 999, fontSize: '0.8rem', fontWeight: 600 }}>
                {selectedPatient.blood_group}
              </span>
            )}
          </h3>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-label)' }}>
            {rankedDonors.length} donors
          </span>
        </div>

        {donorsLoading ? (
          <LoadingSpinner label="Loading ranked donors…" />
        ) : rankedDonors.length === 0 ? (
          <div className="empty-state">
            <p>No ranked donors available for this patient.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ background: 'var(--bg-light)', borderBottom: '2px solid var(--border)' }}>
                  {['#', 'Donor ID', 'Blood', 'Score Breakdown', 'Reliability', 'Donations', 'Eligibility', 'Actions'].map((h) => (
                    <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: 'var(--text-label)', fontWeight: 600, fontSize: '0.78rem', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rankedDonors.slice(0, 50).map((donor, idx) => {
                  const contacted = contactedDonors.has(donor.donor_id);
                  return (
                    <tr
                      key={donor.donor_id}
                      style={{
                        borderBottom: '1px solid var(--border)',
                        background: contacted ? '#f7f7f7' : idx % 2 === 0 ? 'var(--white)' : 'var(--bg-light)',
                        opacity: contacted ? 0.75 : 1,
                      }}
                    >
                      <td style={{ padding: '10px 12px', color: 'var(--text-label)', fontWeight: 700 }}>{idx + 1}</td>
                      <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: '0.8rem', maxWidth: 140 }}>
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {donor.donor_id}
                        </div>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{ background: '#fee', color: '#c53030', padding: '2px 8px', borderRadius: 999, fontWeight: 600, fontSize: '0.78rem' }}>
                          {donor.blood_group || '?'}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          <span style={{ background: (donor.relationship_score || 0) > 0 ? '#fee' : '#f0f4f8', color: (donor.relationship_score || 0) > 0 ? '#c53030' : '#718096', padding: '2px 7px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 600, border: '1px solid currentColor' }}>
                            R:{donor.relationship_score || 0}
                          </span>
                          <span style={{ background: '#fef5e7', color: '#f39c12', padding: '2px 7px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 600, border: '1px solid currentColor' }}>
                            Rel:{(donor.reliability_score || 0).toFixed(0)}
                          </span>
                          <span style={{ background: '#e8f5e9', color: '#27ae60', padding: '2px 7px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 600, border: '1px solid currentColor' }}>
                            Score:{(donor.total_score || 0).toFixed(0)}
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 60, height: 6, background: '#eee', borderRadius: 3 }}>
                            <div style={{ width: `${Math.round((donor.normalized_reliability_score || 0) * 100)}%`, height: '100%', background: '#2b8aef', borderRadius: 3 }} />
                          </div>
                          <span style={{ fontSize: '0.78rem', color: 'var(--text-label)' }}>
                            {Math.round((donor.normalized_reliability_score || 0) * 100)}%
                          </span>
                        </div>
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                        {donor.donations_till_date ?? '—'}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{
                          background: donor.eligibility_status === 'eligible' ? '#e8f5e9' : '#fef5e7',
                          color: donor.eligibility_status === 'eligible' ? '#27ae60' : '#f39c12',
                          padding: '2px 8px',
                          borderRadius: 999,
                          fontSize: '0.78rem',
                          fontWeight: 600,
                        }}>
                          {donor.eligibility_status || 'unknown'}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        {contacted ? (
                          <span style={{ background: '#e2e8f0', color: '#718096', padding: '4px 10px', borderRadius: 999, fontSize: '0.78rem', fontWeight: 600 }}>
                            Contacted
                          </span>
                        ) : (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button
                              className="btn btn-sm"
                              style={{ background: 'var(--accent)', color: '#fff', border: 'none', fontSize: '0.78rem', padding: '5px 10px' }}
                              onClick={() => handleSendOutreach(donor.donor_id)}
                            >
                              Send
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{ fontSize: '0.78rem', padding: '5px 10px' }}
                              onClick={() => openChat(donor.donor_id, selectedPatientId)}
                            >
                              Chat
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 4 — BULK STAGE OUTREACH
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="card">
        <h3 style={{ margin: '0 0 16px 0' }}>Bulk Stage Outreach</h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
          {/* Stage 1 */}
          <div style={{
            border: '2px solid #27ae60',
            borderRadius: 'var(--radius)',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}>
            <div>
              <div style={{ fontWeight: 700, color: '#27ae60', fontSize: '0.9rem' }}>Stage 1</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-label)' }}>Bridge Donors Only</div>
            </div>
            <button
              className="btn btn-sm"
              style={{ border: '2px solid #27ae60', background: 'transparent', color: '#27ae60', fontWeight: 600 }}
              disabled={stageLoading[1] || !selectedPatientId}
              onClick={() => handleStageOutreach(1)}
            >
              {stageLoading[1] ? <><Spin /> Sending…</> : '📤 Send Stage 1'}
            </button>
            {stageResults[1] && (
              <div style={{ background: '#e8f5e9', borderRadius: 6, padding: '10px 12px', fontSize: '0.82rem' }}>
                <div style={{ fontWeight: 700, color: '#27ae60', marginBottom: 4 }}>✓ Stage 1 outreach sent</div>
                <div style={{ color: '#2d6a4f' }}>{stageResults[1].donors_contacted ?? stageResults[1].messages_generated ?? 0} bridge donors contacted</div>
                {stageResults[1].sample_message && (
                  <div style={{ background: '#d8f3dc', padding: '6px 8px', borderRadius: 4, marginTop: 6, fontStyle: 'italic', color: '#1b4332', fontSize: '0.78rem' }}>
                    "{stageResults[1].sample_message.slice(0, 120)}…"
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Stage 2 */}
          <div style={{
            border: '2px solid #f39c12',
            borderRadius: 'var(--radius)',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}>
            <div>
              <div style={{ fontWeight: 700, color: '#f39c12', fontSize: '0.9rem' }}>Stage 2</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-label)' }}>Add Emergency Donors</div>
            </div>
            <button
              className="btn btn-sm"
              style={{ border: '2px solid #f39c12', background: 'transparent', color: '#f39c12', fontWeight: 600 }}
              disabled={stageLoading[2] || !selectedPatientId}
              onClick={() => handleStageOutreach(2)}
            >
              {stageLoading[2] ? <><Spin /> Sending…</> : '⚡ Send Stage 2'}
            </button>
            {stageResults[2] && (
              <div style={{ background: '#fef5e7', borderRadius: 6, padding: '10px 12px', fontSize: '0.82rem' }}>
                <div style={{ fontWeight: 700, color: '#f39c12', marginBottom: 4 }}>✓ Stage 2 outreach sent</div>
                <div style={{ color: '#92400e' }}>{stageResults[2].donors_contacted ?? stageResults[2].messages_generated ?? 0} donors contacted total</div>
              </div>
            )}
          </div>

          {/* Stage 3 */}
          <div style={{
            border: '2px solid var(--accent)',
            borderRadius: 'var(--radius)',
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--accent)', fontSize: '0.9rem' }}>Stage 3</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-label)' }}>Full Broadcast + Incentives</div>
            </div>
            <button
              className="btn btn-sm"
              style={{ background: 'var(--accent)', color: '#fff', fontWeight: 600, border: 'none' }}
              disabled={stageLoading[3] || !selectedPatientId}
              onClick={() => handleStageOutreach(3)}
            >
              {stageLoading[3] ? <><Spin /> Sending…</> : '🚨 Send Stage 3'}
            </button>
            {stageResults[3] && (
              <div style={{ background: '#fee', borderRadius: 6, padding: '10px 12px', fontSize: '0.82rem' }}>
                <div style={{ fontWeight: 700, color: '#c53030', marginBottom: 4 }}>✓ Stage 3 broadcast sent</div>
                <div style={{ color: '#7b1d1d' }}>{stageResults[3].donors_contacted ?? stageResults[3].messages_generated ?? 0} donors contacted</div>
                <div style={{ color: '#7b1d1d', marginTop: 2 }}>Incentive messages included</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          SECTION 5 — RESPONSE TRACKER
      ══════════════════════════════════════════════════════════════════════ */}
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: '0 0 2px 0', fontSize: '1rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>
              Outreach Responses
            </h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-label)' }}>
              Auto-refreshes every 20 seconds
              {notifsLoading && <span style={{ marginLeft: 8 }}><Spin /></span>}
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={loadNotifications}
          >
            ↻ Refresh
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {/* Left: Contacted */}
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-label)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              Contacted ({outreachNotifs.length})
            </div>
            {outreachNotifs.length === 0 ? (
              <div style={{ padding: '16px', background: 'var(--bg-light)', borderRadius: 'var(--radius)', color: 'var(--text-label)', fontSize: '0.85rem', textAlign: 'center' }}>
                No outreach sent yet
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
                {outreachNotifs.map((n) => {
                  const stage = extractStageFromType(n.notification_type);
                  const sc = stage ? stageColor(stage) : { bg: '#f0f4f8', color: '#718096', label: '?' };
                  return (
                    <div key={n.id} style={{
                      padding: '10px 12px',
                      background: 'var(--bg-light)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                    }}>
                      <span style={{ background: sc.bg, color: sc.color, padding: '2px 8px', borderRadius: 999, fontSize: '0.72rem', fontWeight: 700, flexShrink: 0 }}>
                        {sc.label}
                      </span>
                      <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {(n.donor_id || '').slice(0, 18)}…
                      </span>
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-label)', flexShrink: 0 }}>
                        {timeAgo(n.sent_at)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: Responded */}
          <div>
            <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-label)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '.04em' }}>
              Responded ({respondedNotifs.length})
            </div>
            {respondedNotifs.length === 0 ? (
              <div style={{ padding: '16px', background: 'var(--bg-light)', borderRadius: 'var(--radius)', color: 'var(--text-label)', fontSize: '0.85rem', textAlign: 'center' }}>
                No responses yet
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflowY: 'auto' }}>
                {respondedNotifs.map((n) => {
                  const positive = isPositiveResponse(n.response);
                  return (
                    <div key={n.id} style={{
                      padding: '10px 12px',
                      background: positive ? '#e8f5e9' : 'var(--bg-light)',
                      border: `1px solid ${positive ? '#27ae60' : 'var(--border)'}`,
                      borderRadius: 'var(--radius)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.78rem', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {(n.donor_id || '').slice(0, 18)}…
                        </span>
                        {positive && (
                          <span style={{ background: '#27ae60', color: '#fff', padding: '2px 8px', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, flexShrink: 0 }}>
                            CONFIRMED
                          </span>
                        )}
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-label)', flexShrink: 0 }}>
                          {timeAgo(n.responded_at || n.sent_at)}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.82rem', color: positive ? '#1b4332' : 'var(--text-body)', fontStyle: 'italic' }}>
                        "{n.response}"
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {positive && (
                          <button
                            className="btn btn-sm"
                            style={{ background: '#27ae60', color: '#fff', border: 'none', fontSize: '0.75rem', padding: '4px 10px' }}
                            onClick={() => handleReserve(n.donor_id, n.patient_id)}
                          >
                            Reserve
                          </button>
                        )}
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ fontSize: '0.75rem', padding: '4px 10px' }}
                          onClick={() => openChat(n.donor_id, n.patient_id)}
                        >
                          Chat
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          CHAT DRAWER
      ══════════════════════════════════════════════════════════════════════ */}
      <div className={`drawer-backdrop ${drawerOpen ? 'open' : ''}`} onClick={() => setDrawerOpen(false)} />

      <div className={`drawer ${drawerOpen ? 'open' : ''}`}>
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 style={{ margin: 0, fontSize: '0.95rem' }}>CHAT WITH DONOR</h3>
            {drawerDonorId && (
              <span style={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-label)' }}>
                {drawerDonorId.slice(0, 16)}…
              </span>
            )}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => setDrawerOpen(false)}>Close</button>
        </div>

        <div className="drawer-body" style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 70px)' }}>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, paddingBottom: 12 }}>
            {drawerLoading ? (
              <LoadingSpinner label="Loading conversation…" />
            ) : drawerHistory.length > 0 ? (
              drawerHistory.map((msg, i) => {
                const isAssistant = msg.role === 'assistant';
                return (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: isAssistant ? 'flex-start' : 'flex-end', width: '100%' }}>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-label)', marginBottom: 2, padding: '0 4px' }}>
                      {isAssistant ? 'Priya' : 'Donor'}
                    </span>
                    <div style={{
                      background: isAssistant ? 'var(--accent)' : 'var(--text-heading)',
                      color: '#fff',
                      padding: '10px 14px',
                      borderRadius: 'var(--radius)',
                      maxWidth: '85%',
                      wordBreak: 'break-word',
                      boxShadow: 'var(--shadow)',
                    }}>
                      <p style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: '0.9rem' }}>
                        {msg.message || msg.text || msg.content}
                      </p>
                    </div>
                  </div>
                );
              })
            ) : (
              <p style={{ textAlign: 'center', color: 'var(--text-label)' }}>No messages yet.</p>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Quick replies */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '12px 0 6px 0' }}>
            {['Thank you for confirming', 'Please come to Care Hospital, Banjara Hills', 'Bring your ID and mention Blood Warriors'].map((text) => (
              <button
                key={text}
                type="button"
                className="chip"
                style={{ fontSize: '0.72rem', padding: '4px 8px', margin: 0 }}
                onClick={async () => {
                  setDrawerSending(true);
                  try {
                    await postSaveMessage(drawerDonorId, drawerPatientId || selectedPatientId, text, 'assistant');
                    await postNotifyDonor(drawerDonorId, drawerPatientId || selectedPatientId, text, 1);
                    const updated = await getConversations(drawerDonorId, drawerPatientId || selectedPatientId);
                    setDrawerHistory(updated?.history || []);
                  } catch (err) {
                    showToast('Failed to send', 'error');
                  } finally {
                    setDrawerSending(false);
                  }
                }}
                disabled={drawerSending}
              >
                {text}
              </button>
            ))}
          </div>

          {/* Input */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-label)', marginBottom: 6 }}>
              Writing as Priya — Blood Warriors coordinator
            </div>
            <form onSubmit={handleDrawerSend} style={{ display: 'flex', gap: 8 }}>
              <textarea
                className="form-input"
                rows={2}
                placeholder="Type as Priya…"
                value={drawerInput}
                onChange={(e) => setDrawerInput(e.target.value)}
                style={{ resize: 'none', flex: 1 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleDrawerSend();
                  }
                }}
              />
              <button
                type="submit"
                className="btn btn-danger"
                style={{ background: 'var(--accent)', color: '#fff', height: 'fit-content', alignSelf: 'flex-end', border: 'none' }}
                disabled={drawerSending || !drawerInput.trim()}
              >
                {drawerSending ? '…' : 'Send'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
