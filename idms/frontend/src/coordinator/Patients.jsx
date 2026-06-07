import { useEffect, useMemo, useState, useCallback } from 'react';
import { getPatients, getScheduleStatus, getBridgesByPatient, triggerWorkflow, getActiveEmergencies, resolveEmergency, postOutreach, getPendingHandoffs } from '../api.js';
import { CoordinatorChat } from './CoordinatorChat.jsx';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { formatDate } from '../utils.js';

function daysUntil(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);
  return Math.round((date - today) / (1000 * 60 * 60 * 24));
}

export function CoordinatorPatients() {
  const [patients, setPatients] = useState([]);
  const [scheduleStatus, setScheduleStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState({});
  const [bridgesCache, setBridgesCache] = useState({});

  // Emergency state
  const [activeEmergencies, setActiveEmergencies] = useState([]);
  const [outreachStatus, setOutreachStatus] = useState({}); // { patientId: { stage, loading, result } }
  const [resolveLoading, setResolveLoading] = useState({});
  const [patientMap, setPatientMap] = useState({});

  // Coordinator handoff queue
  const [pendingHandoffs, setPendingHandoffs] = useState([]);
  const [activeHandoff, setActiveHandoff] = useState(null); // the handoff currently open in the chat drawer

  const fetchEmergencies = useCallback(async () => {
    const data = await getActiveEmergencies();
    setActiveEmergencies(data);
  }, []);

  const fetchHandoffs = useCallback(async () => {
    const data = await getPendingHandoffs();
    setPendingHandoffs(data);
  }, []);

  useEffect(() => {
    async function loadPageData() {
      try {
        const [patientsData, scheduleData] = await Promise.all([
          getPatients({ limit: 1000 }),
          getScheduleStatus(),
        ]);
        const pts = Array.isArray(patientsData) ? patientsData : [];
        setPatients(pts);
        setScheduleStatus(scheduleData || {});
        // Build a quick lookup map patient_id -> patient
        const map = {};
        pts.forEach((p) => { map[p.patient_id] = p; });
        setPatientMap(map);
      } catch (err) {
        setPatients([]);
        setScheduleStatus({});
      } finally {
        setLoading(false);
      }
    }

    loadPageData();
    fetchEmergencies();
    fetchHandoffs();

    // Poll emergencies every 30s, handoffs every 10s
    const emergencyInterval = setInterval(fetchEmergencies, 30000);
    const handoffInterval = setInterval(fetchHandoffs, 10000);
    return () => {
      clearInterval(emergencyInterval);
      clearInterval(handoffInterval);
    };
  }, [fetchEmergencies, fetchHandoffs]);

  const rows = useMemo(() => {
    const scheduleMap = new Map(
      (Array.isArray(scheduleStatus.active_patients) ? scheduleStatus.active_patients : []).map((item) => [item.patient_id, item])
    );

    return patients.map((patient) => {
      const schedule = scheduleMap.get(patient.patient_id) || {};
      return {
        ...patient,
        escalation_stage: schedule.escalation_stage,
        next_transfusion_date: patient.expected_next_transfusion_date,
      };
    });
  }, [patients, scheduleStatus]);

  function shortId(id) {
    if (!id) return 'unknown';
    const str = String(id);
    return str.length > 12 ? str.substring(0, 12) : str;
  }

  function stageColor(stage) {
    if (!stage) return 'gray';
    if (stage === 1) return 'green';
    if (stage === 2) return 'orange';
    if (stage === 3) return 'red';
    return 'gray';
  }

  if (loading) {
    return <LoadingSpinner label="Loading patients" />;
  }

  if (!rows.length) {
    return <EmptyState title="No patients" message="No patient records are available." />;
  }

  const total = rows.length;
  const critical = rows.filter((r) => {
    const d = r.next_transfusion_date ? new Date(r.next_transfusion_date) : null;
    return d ? (d < new Date()) : false;
  }).length;
  const urgent = rows.filter((r) => {
    const d = r.next_transfusion_date ? new Date(r.next_transfusion_date) : null;
    if (!d) return false;
    const delta = Math.ceil((d - new Date()) / (1000 * 60 * 60 * 24));
    return delta >= 0 && delta <= 7;
  }).length;
  const stable = total - critical - urgent;

  const handleTriggerOutreach = async (patientId) => {
    try {
      await triggerWorkflow(patientId);
    } catch (err) {
      // ignore for now
    }
  };

  const handleBroadcast = async (patientId, stage) => {
    setOutreachStatus((s) => ({ ...s, [patientId]: { stage, loading: true, result: null } }));
    try {
      const result = await postOutreach(patientId, stage);
      setOutreachStatus((s) => ({
        ...s,
        [patientId]: { stage, loading: false, result: `✅ Stage ${stage} broadcast sent to ${result.donors_contacted ?? 0} donors.` },
      }));
    } catch (err) {
      setOutreachStatus((s) => ({
        ...s,
        [patientId]: { stage, loading: false, result: `❌ Broadcast failed: ${err.message}` },
      }));
    }
  };

  const handleResolve = async (patientId) => {
    setResolveLoading((s) => ({ ...s, [patientId]: true }));
    try {
      await resolveEmergency(patientId);
      await fetchEmergencies();
    } catch (err) {
      // silent
    } finally {
      setResolveLoading((s) => ({ ...s, [patientId]: false }));
    }
  };

  const toggleExpand = async (patientId) => {
    setExpanded((s) => ({ ...s, [patientId]: !s[patientId] }));
    if (!bridgesCache[patientId]) {
      try {
        const bridges = await getBridgesByPatient(patientId);
        setBridgesCache((c) => ({ ...c, [patientId]: bridges }));
      } catch (err) {
        setBridgesCache((c) => ({ ...c, [patientId]: [] }));
      }
    }
  };

  return (
    <div>
      {/* ── Coordinator Chat Drawer (renders as portal-style overlay) ── */}
      {activeHandoff && (
        <CoordinatorChat
          handoff={activeHandoff}
          onClose={() => {
            setActiveHandoff(null);
            fetchHandoffs();
          }}
        />
      )}

      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2>Patient Care Dashboard</h2>
        <p>Mission control for patient transfusion readiness.</p>
      </div>

      <div className="card" style={{ marginBottom: '1rem', display: 'flex', gap: '1rem' }}>
        <div><strong>Total patients:</strong> {total}</div>
        <div><strong>Critical:</strong> <span style={{ color: 'red' }}>{critical}</span></div>
        <div><strong>Urgent (≤7d):</strong> <span style={{ color: 'orange' }}>{urgent}</span></div>
        <div><strong>Stable:</strong> <span style={{ color: 'green' }}>{stable}</span></div>
        {activeEmergencies.length > 0 && (
          <div style={{ marginLeft: 'auto' }}>
            <span style={{
              background: '#e53e3e', color: '#fff', borderRadius: '999px',
              padding: '2px 12px', fontWeight: 700, fontSize: '0.85rem', animation: 'pulse 1.5s infinite'
            }}>
              🚨 {activeEmergencies.length} Active Emergency{activeEmergencies.length > 1 ? 's' : ''}
            </span>
          </div>
        )}
        {pendingHandoffs.length > 0 && (
          <div style={{ marginLeft: activeEmergencies.length > 0 ? '0.5rem' : 'auto' }}>
            <span style={{
              background: '#805ad5', color: '#fff', borderRadius: '999px',
              padding: '2px 12px', fontWeight: 700, fontSize: '0.85rem',
            }}>
              🔔 {pendingHandoffs.length} Handoff{pendingHandoffs.length > 1 ? 's' : ''} Waiting
            </span>
          </div>
        )}
      </div>

      {/* ── Emergency Alert Panel ── */}
      {activeEmergencies.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          <div style={{
            background: 'linear-gradient(135deg, rgba(229,62,62,0.12), rgba(229,62,62,0.04))',
            border: '1.5px solid rgba(229,62,62,0.5)',
            borderRadius: '12px',
            padding: '1.25rem 1.5rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
              <span style={{ fontSize: '1.4rem' }}>🚨</span>
              <div>
                <h3 style={{ margin: 0, color: '#e53e3e', fontSize: '1.05rem', fontWeight: 700 }}>Active Patient Emergencies</h3>
                <p style={{ margin: 0, fontSize: '0.8rem', opacity: 0.7 }}>These patients have self-reported urgent blood needs. Broadcast outreach or resolve below.</p>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {activeEmergencies.map((em) => {
                const patient = patientMap[em.patient_id];
                const bloodGroup = patient?.blood_group || '—';
                const declaredTime = em.declared_at ? new Date(em.declared_at).toLocaleString() : 'unknown';
                const os = outreachStatus[em.patient_id];
                const isResolving = resolveLoading[em.patient_id];

                return (
                  <div key={em.patient_id} style={{
                    background: 'rgba(229,62,62,0.07)',
                    border: '1px solid rgba(229,62,62,0.25)',
                    borderRadius: '10px',
                    padding: '1rem 1.25rem',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '1rem',
                  }}>
                    {/* Patient info */}
                    <div style={{ flex: '1 1 180px' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.95rem', fontFamily: 'monospace' }}>
                        {shortId(em.patient_id)}
                      </div>
                      <div style={{ fontSize: '0.78rem', opacity: 0.7 }}>
                        Blood: <strong>{bloodGroup}</strong> · Declared: {declaredTime}
                      </div>
                      {em.reason && (
                        <div style={{ fontSize: '0.78rem', color: '#e53e3e', marginTop: '2px' }}>📋 {em.reason}</div>
                      )}
                    </div>

                    {/* Broadcast buttons */}
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.78rem', fontWeight: 600, opacity: 0.7 }}>Broadcast:</span>
                      {[1, 2, 3].map((stage) => {
                        const stageLabels = { 1: '🟢 Stage 1 — Bridge', 2: '🟠 Stage 2 — Emergency', 3: '🔴 Stage 3 — All' };
                        const stageBg = { 1: '#276749', 2: '#c05621', 3: '#c53030' };
                        const isLoading = os?.loading && os?.stage === stage;
                        return (
                          <button
                            key={stage}
                            onClick={() => handleBroadcast(em.patient_id, stage)}
                            disabled={os?.loading}
                            style={{
                              background: stageBg[stage],
                              color: '#fff',
                              border: 'none',
                              borderRadius: '7px',
                              padding: '5px 12px',
                              fontSize: '0.78rem',
                              fontWeight: 600,
                              cursor: os?.loading ? 'not-allowed' : 'pointer',
                              opacity: os?.loading && os?.stage !== stage ? 0.5 : 1,
                              transition: 'opacity 0.2s',
                            }}
                          >
                            {isLoading ? '⏳ Sending…' : stageLabels[stage]}
                          </button>
                        );
                      })}
                    </div>

                    {/* Resolve button */}
                    <button
                      onClick={() => handleResolve(em.patient_id)}
                      disabled={isResolving}
                      style={{
                        background: 'transparent',
                        color: '#38a169',
                        border: '1.5px solid #38a169',
                        borderRadius: '7px',
                        padding: '5px 14px',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        cursor: isResolving ? 'not-allowed' : 'pointer',
                        opacity: isResolving ? 0.6 : 1,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {isResolving ? '⏳ Resolving…' : '✅ Mark Resolved'}
                    </button>

                    {/* Broadcast result feedback */}
                    {os?.result && (
                      <div style={{
                        width: '100%',
                        fontSize: '0.8rem',
                        padding: '6px 10px',
                        borderRadius: '6px',
                        background: os.result.startsWith('✅') ? 'rgba(56,161,105,0.12)' : 'rgba(229,62,62,0.12)',
                        color: os.result.startsWith('✅') ? '#276749' : '#c53030',
                        fontWeight: 600,
                      }}>
                        {os.result}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {/* ── Handoff Queue Panel ── */}
      {pendingHandoffs.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          <div style={{
            background: 'linear-gradient(135deg, rgba(128,90,213,0.12), rgba(128,90,213,0.04))',
            border: '1.5px solid rgba(128,90,213,0.45)',
            borderRadius: '12px',
            padding: '1.25rem 1.5rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
              <span style={{ fontSize: '1.4rem' }}>🔔</span>
              <div>
                <h3 style={{ margin: 0, color: '#9f7aea', fontSize: '1.05rem', fontWeight: 700 }}>
                  Coordinator Handoff Queue
                </h3>
                <p style={{ margin: 0, fontSize: '0.8rem', opacity: 0.7 }}>
                  These donors gave uncertain responses. AI is paused — click "Open Chat" to take over.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {pendingHandoffs.map((h) => {
                const elapsed = h.flagged_at
                  ? Math.round((Date.now() - new Date(h.flagged_at).getTime()) / 60000)
                  : null;
                return (
                  <div key={`${h.donor_id}-${h.patient_id}`} style={{
                    background: 'rgba(128,90,213,0.08)',
                    border: '1px solid rgba(128,90,213,0.25)',
                    borderRadius: '10px',
                    padding: '0.875rem 1.1rem',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '1rem',
                  }}>
                    <div style={{ flex: '1 1 200px' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.85rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <span>🩸 Donor: <code style={{ fontSize: '0.75rem' }}>{shortId(h.donor_id)}</code></span>
                        <span style={{ opacity: 0.5 }}>·</span>
                        <span>🏥 Patient: <code style={{ fontSize: '0.75rem' }}>{shortId(h.patient_id)}</code></span>
                      </div>
                      {h.donor_message && (
                        <div style={{ fontSize: '0.78rem', color: '#9f7aea', marginTop: '4px' }}>
                          💬 <em>"{h.donor_message.length > 80 ? h.donor_message.slice(0, 80) + '…' : h.donor_message}"</em>
                        </div>
                      )}
                      {elapsed !== null && (
                        <div style={{ fontSize: '0.72rem', opacity: 0.5, marginTop: 2 }}>
                          ⏱ {elapsed < 1 ? 'just now' : `${elapsed} min ago`}
                        </div>
                      )}
                    </div>

                    <button
                      onClick={() => setActiveHandoff(h)}
                      style={{
                        background: '#805ad5',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '8px',
                        padding: '7px 16px',
                        fontWeight: 700,
                        fontSize: '0.82rem',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        boxShadow: '0 2px 8px rgba(128,90,213,0.35)',
                      }}
                    >
                      💬 Open Chat
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Blood group</th>
              <th>Next transfusion</th>
              <th>Urgency</th>
              <th>Escalation</th>
              <th>Bridge donors</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const d = row.next_transfusion_date ? new Date(row.next_transfusion_date) : null;
              const days = d ? Math.ceil((d - new Date()) / (1000 * 60 * 60 * 24)) : null;
              const urgency = days == null ? 'STABLE' : days < 0 ? 'CRITICAL' : days <= 7 ? 'URGENT' : 'STABLE';
              return (
                <>
                  <tr key={row.patient_id} onClick={() => toggleExpand(row.patient_id)} style={{ cursor: 'pointer' }}>
                    <td>{shortId(row.patient_id)}</td>
                    <td>{row.blood_group || 'unknown'}</td>
                    <td>{formatDate(row.next_transfusion_date)} {days != null ? `(${days}d)` : ''}</td>
                    <td style={{ color: urgency === 'CRITICAL' ? 'red' : urgency === 'URGENT' ? 'orange' : 'green' }}>{urgency}</td>
                    <td>{row.escalation_stage ? `Stage ${row.escalation_stage}` : '—'}</td>
                    <td>{row.bridge_donors_count ?? '—'}</td>
                    <td><button className="btn btn-primary" onClick={(e) => { e.stopPropagation(); handleTriggerOutreach(row.patient_id); }}>Trigger Outreach</button></td>
                  </tr>
                  {expanded[row.patient_id] ? (
                    <tr key={`${row.patient_id}-expanded`}>
                      <td colSpan={7}>
                        <strong>Bridge donors:</strong>
                        <div>
                          {(bridgesCache[row.patient_id] || []).length ? (
                            <table className="table">
                              <thead>
                                <tr><th>Donor ID</th><th>Blood</th><th>Donations</th></tr>
                              </thead>
                              <tbody>
                                {(bridgesCache[row.patient_id] || []).map((b) => (
                                  <tr key={b.donor_id}><td style={{ fontFamily: 'monospace' }}>{b.donor_id}</td><td>{b.bridge_blood_group}</td><td>{b.donations_till_date}</td></tr>
                                ))}
                              </tbody>
                            </table>
                          ) : (
                            <p>No bridge donors on record.</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
