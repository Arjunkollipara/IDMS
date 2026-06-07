import { useEffect, useMemo, useRef, useState } from 'react';
import { getBridges, getConversations, getDonors, postChat, postOutreach } from '../api';
import EmptyState from '../components/EmptyState';
import LoadingSpinner from '../components/LoadingSpinner';
import SkeletonCard from '../components/SkeletonCard';
import { formatDate, formatDateTime, timeAgo, truncateId } from '../utils';

const DEFAULT_API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const CATEGORY_FILTERS = ['all', 'Bridge Donor', 'Emergency Donor', 'Guest', 'Volunteer'];
const STATUS_FILTERS = ['all', 'active', 'inactive'];
const OUTREACH_STAGES = [
  { value: '1', label: 'Stage 1' },
  { value: '2', label: 'Stage 2' },
  { value: '3', label: 'Stage 3' },
];

export default function Donors({ notify = () => {}, apiBase = DEFAULT_API_BASE }) {
  const [donors, setDonors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedDonor, setSelectedDonor] = useState(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [bridges, setBridges] = useState([]);
  const [selectedPatientId, setSelectedPatientId] = useState('');
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [currentStage, setCurrentStage] = useState('initial_outreach');
  const [outreachStage, setOutreachStage] = useState('1');
  const [outreachDraft, setOutreachDraft] = useState('');
  const [outreachLoading, setOutreachLoading] = useState(false);
  const [chatMessage, setChatMessage] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const historyRef = useRef(null);

  useEffect(() => {
    let mounted = true;

    async function loadDonors() {
      try {
        setLoading(true);
        setError('');
        const response = await fetch(`${apiBase}/donors?limit=100`);
        const payload = await response.json();
        console.log('donors response', response);
        console.log('donors payload', payload);
        console.log('loading state', loading);

        if (!mounted) {
          return;
        }

        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || 'Failed to load donors');
        }

        setDonors(Array.isArray(payload.donors) ? payload.donors : []);
      } catch (err) {
        if (mounted) {
          setError(err.message);
          notify(err.message, 'error');
        }
      } finally {
        if (mounted) {
          setLoading(false);
          console.log('donors loading false');
        }
      }
    }

    loadDonors();

    return () => {
      mounted = false;
    };
  }, [apiBase]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedDonor(null);
      setBridges([]);
      setSelectedPatientId('');
      setHistory([]);
      setHistoryError('');
      setCurrentStage('initial_outreach');
      setOutreachDraft('');
      setChatMessage('');
      return;
    }

    setSelectedDonor(null);
    setBridges([]);
    setSelectedPatientId('');
    setHistory([]);
    setHistoryError('');
    setCurrentStage('initial_outreach');
    setOutreachDraft('');
    setChatMessage('');

    let mounted = true;

    async function loadDrawerData() {
      try {
        setDrawerLoading(true);

        const donorPromise = fetch(`${apiBase}/donors/${encodeURIComponent(String(selectedId))}`);
        const bridgesPromise = getBridges({ donor_id: selectedId, limit: 100 });

        const donorResponse = await donorPromise;
        const donorPayload = await donorResponse.json();
        console.log('donor detail response', donorResponse);
        console.log('donor detail payload', donorPayload);
        if (!mounted) {
          return;
        }

        if (!donorResponse.ok || donorPayload.success === false) {
          throw new Error(donorPayload.error || 'Failed to load donor details');
        }

        setSelectedDonor(donorPayload && typeof donorPayload.donor === 'object' && donorPayload.donor ? donorPayload.donor : null);

        const bridgesResponse = await bridgesPromise;
        if (!mounted) {
          return;
        }

        const bridgeRows = Array.isArray(bridgesResponse) ? bridgesResponse : [];
        setBridges(bridgeRows);
        setSelectedPatientId((current) => {
          if (current && bridgeRows.some((bridge) => bridge.patient_id === current)) {
            return current;
          }
          return bridgeRows.find((bridge) => bridge.patient_id)?.patient_id || '';
        });
      } catch (err) {
        if (mounted) {
          notify(err.message, 'error');
        }
      } finally {
        if (mounted) {
          setDrawerLoading(false);
        }
      }
    }

    loadDrawerData();

    return () => {
      mounted = false;
    };
  }, [apiBase, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      return;
    }

    let mounted = true;

    async function loadHistory() {
      try {
        setHistoryLoading(true);
        setHistoryError('');

        const payload = selectedPatientId
          ? await getConversations(selectedId, selectedPatientId, 'coordinator')
          : await getConversations(selectedId, null, 'coordinator');

        if (!mounted) {
          return;
        }

        const rows = Array.isArray(payload?.history) ? payload.history : [];
        setHistory(rows);
        setCurrentStage(rows.length ? rows[rows.length - 1]?.conversation_stage || 'initial_outreach' : 'initial_outreach');
      } catch (err) {
        if (mounted) {
          setHistory([]);
          setHistoryError(err?.response?.data?.error || err?.response?.data?.detail || err.message || 'Failed to load conversation history');
        }
      } finally {
        if (mounted) {
          setHistoryLoading(false);
        }
      }
    }

    loadHistory();

    return () => {
      mounted = false;
    };
  }, [selectedId, selectedPatientId]);

  useEffect(() => {
    if (!historyRef.current) {
      return;
    }
    historyRef.current.scrollTop = historyRef.current.scrollHeight;
  }, [history]);

  const filteredDonors = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return donors.filter((donor) => {
      const matchesText =
        !needle ||
        [donor.user_id, donor.blood_group, donor.donor_category, donor.eligibility_status]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle));

      const matchesCategory = categoryFilter === 'all' || String(donor.donor_category || '') === categoryFilter;
      const matchesStatus =
        statusFilter === 'all' || String(donor.user_donation_active_status || '').toLowerCase() === statusFilter;

      return matchesText && matchesCategory && matchesStatus;
    });
  }, [categoryFilter, donors, query, statusFilter]);

  const reliabilitySummary = useMemo(() => {
    return donors.reduce(
      (acc, donor) => {
        const score = normalizeScore(donor?.normalized_reliability_score);
        if (score >= 70) {
          acc.high += 1;
        } else if (score >= 40) {
          acc.mid += 1;
        } else {
          acc.low += 1;
        }
        return acc;
      },
      { high: 0, mid: 0, low: 0 }
    );
  }, [donors]);

  const selectedBridge = useMemo(() => {
    if (!bridges.length) {
      return null;
    }
    return bridges.find((bridge) => bridge.patient_id === selectedPatientId) || bridges[0];
  }, [bridges, selectedPatientId]);

  const recommendationReasons = useMemo(() => {
    const reasons = [];
    const reliability = formatScore(selectedDonor?.normalized_reliability_score);
    const bridgeDonations = selectedBridge?.donations_till_date ?? selectedDonor?.donations_till_date;

    if (selectedBridge) {
      reasons.push(`${bridgeDonations ?? 0} donations on this patient bridge`);
      if (selectedBridge.status_of_bridge) {
        reasons.push(`${selectedBridge.status_of_bridge} bridge relationship`);
      }
      if (selectedBridge.bridge_blood_group) {
        reasons.push(`${selectedBridge.bridge_blood_group} bridge blood group`);
      }
    }

    if (selectedDonor?.donor_category) {
      reasons.push(selectedDonor.donor_category);
    }

    if (reliability !== '—') {
      reasons.push(`${reliability} reliability`);
    }

    if (selectedDonor?.donations_till_date !== undefined && selectedDonor?.donations_till_date !== null) {
      reasons.push(`${selectedDonor.donations_till_date} total donations`);
    }

    if (selectedDonor?.last_donation_date) {
      reasons.push(`Last donation ${timeAgo(selectedDonor.last_donation_date)}`);
    }

    if (history.length) {
      reasons.push(`${history.length} previous interaction${history.length === 1 ? '' : 's'}`);
    }

    return reasons;
  }, [history.length, selectedBridge, selectedDonor]);

  function closeDrawer() {
    setSelectedId(null);
    setSelectedDonor(null);
    setBridges([]);
    setSelectedPatientId('');
    setHistory([]);
    setHistoryError('');
    setCurrentStage('initial_outreach');
    setOutreachStage('1');
    setOutreachDraft('');
    setChatMessage('');
  }

  async function generateOutreach() {
    if (!selectedId || !selectedPatientId) {
      return;
    }

    try {
      setOutreachLoading(true);
      setHistoryError('');
      const payload = await postOutreach(selectedPatientId, Number(outreachStage));
      setOutreachDraft(payload?.sample_message || '');
      notify(
        payload?.sample_message ? 'Outreach message generated' : 'Outreach generated with no sample message',
        'success'
      );
    } catch (err) {
      const message = err?.response?.data?.error || err?.response?.data?.detail || err.message || 'Failed to generate outreach';
      setHistoryError(message);
      notify(message, 'error');
    } finally {
      setOutreachLoading(false);
    }
  }

  async function refreshConversation() {
    if (!selectedId) {
      return [];
    }

    try {
      setHistoryLoading(true);
      setHistoryError('');
      const payload = selectedPatientId
        ? await getConversations(selectedId, selectedPatientId, 'coordinator')
        : await getConversations(selectedId, null, 'coordinator');
      const rows = Array.isArray(payload?.history) ? payload.history : [];
      setHistory(rows);
      setCurrentStage(rows.length ? rows[rows.length - 1]?.conversation_stage || 'initial_outreach' : 'initial_outreach');
      return rows;
    } catch (err) {
      const message = err?.response?.data?.error || err?.response?.data?.detail || err.message || 'Failed to load conversation history';
      setHistory([]);
      setHistoryError(message);
      notify(message, 'error');
      return [];
    } finally {
      setHistoryLoading(false);
    }
  }

  async function sendChat(text, clearTarget) {
    const trimmed = text.trim();
    if (!selectedId || !selectedPatientId || !trimmed) {
      return;
    }

    try {
      setChatLoading(true);
      setHistoryError('');
      const result = await postChat(selectedId, selectedPatientId, trimmed, 'coordinator');
      setCurrentStage(result?.conversation_stage || currentStage);
      await refreshConversation();
      if (clearTarget === 'outreach') {
        setOutreachDraft('');
      } else if (clearTarget === 'chat') {
        setChatMessage('');
      }
      notify('Message sent', 'success');
    } catch (err) {
      const message = err?.response?.data?.error || err?.response?.data?.detail || err.message || 'Failed to send message';
      setHistoryError(message);
      notify(message, 'error');
    } finally {
      setChatLoading(false);
    }
  }

  return (
    <section>
      <div className="section-header">
        <div>
          <h1>Donors</h1>
          <p>Filtered donor registry with reliability scoring and detail inspection.</p>
        </div>
      </div>

      <div className="filter-bar">
        <input
          className="search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search donors"
        />

        <div className="filter-pills">
          {CATEGORY_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              className={`pill ${categoryFilter === filter ? 'active' : ''}`}
              onClick={() => setCategoryFilter(filter)}
            >
              {filter === 'all' ? 'All categories' : filter}
            </button>
          ))}
        </div>

        <div className="filter-pills">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              className={`pill ${statusFilter === filter ? 'active' : ''}`}
              onClick={() => setStatusFilter(filter)}
            >
              {filter === 'all' ? 'All status' : filter}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <SkeletonCard lines={4} />
      ) : error ? (
        <div className="card">
          <EmptyState title="Donors unavailable" message={error} />
        </div>
      ) : filteredDonors.length === 0 ? (
        <div className="card">
          <EmptyState title="No donors found" message="Try a different search or filter." />
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Donor</th>
                <th>Blood Group</th>
                <th>Category</th>
                <th>Reliability</th>
                <th>Eligibility</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredDonors.map((donor) => (
                <tr key={donor.user_id} onClick={() => setSelectedId(donor.user_id)}>
                  <td className="text-mono">{donor.user_id}</td>
                  <td>{donor.blood_group || '—'}</td>
                  <td>{donor.donor_category || '—'}</td>
                  <td>
                    <div className="rel-bar">
                      <div className="rel-bar-track">
                        <div
                          className={`rel-bar-fill ${reliabilityTone(donor.normalized_reliability_score)} ${reliabilityWidth(
                            donor.normalized_reliability_score
                          )}`}
                        />
                      </div>
                      <span className="score-text">{formatScore(donor.normalized_reliability_score)}</span>
                    </div>
                  </td>
                  <td>{donor.eligibility_status || '—'}</td>
                  <td>
                    <span className={`badge ${statusTone(donor.user_donation_active_status)}`}>
                      {donor.user_donation_active_status || 'unknown'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedId ? <div className="overlay" onClick={closeDrawer} /> : null}

      {selectedId ? (
        <aside className="drawer" aria-label="Donor details">
          <div className="drawer-header">
            <div>
              <h2>{selectedDonor?.user_id || selectedId}</h2>
              <p>Profile details, relationship context, and conversation workflow.</p>
            </div>
            <button type="button" className="close-btn" onClick={closeDrawer} aria-label="Close drawer">
              ×
            </button>
          </div>

          <div className="drawer-body">
            {drawerLoading ? (
              <div className="card">
                <LoadingSpinner />
              </div>
            ) : selectedDonor ? (
              <>
                <div className="info-grid">
                  <div className="info-item">
                    <div className="info-label">Donor ID</div>
                    <div className="info-value mono">{selectedDonor.user_id || '—'}</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Blood Group</div>
                    <div className="info-value">{selectedDonor.blood_group || '—'}</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Category</div>
                    <div className="info-value">{selectedDonor.donor_category || '—'}</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Status</div>
                    <div className="info-value">{selectedDonor.user_donation_active_status || '—'}</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Reliability</div>
                    <div className="info-value">{formatScore(selectedDonor.normalized_reliability_score)}</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Total Calls</div>
                    <div className="info-value">{selectedDonor.total_calls ?? '—'}</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Calls to Donations</div>
                    <div className="info-value">{selectedDonor.calls_to_donations_ratio ?? '—'}</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Donations</div>
                    <div className="info-value">{selectedDonor.donations_till_date ?? '—'}</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Last Donation</div>
                    <div className="info-value">{formatDate(selectedDonor.last_donation_date)}</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Next Eligible</div>
                    <div className="info-value">{formatDate(selectedDonor.next_eligible_date)}</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Latitude</div>
                    <div className="info-value mono">{selectedDonor.latitude ?? '—'}</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Longitude</div>
                    <div className="info-value mono">{selectedDonor.longitude ?? '—'}</div>
                  </div>
                </div>

                <div className="divider" />

                <div className="card mb-3">
                  <div className="section-header">
                    <div>
                      <h2>Relationship context</h2>
                      <p>Why this donor is being contacted.</p>
                    </div>
                    <span className={`badge ${statusTone(selectedDonor.user_donation_active_status)}`}>
                      {selectedDonor.user_donation_active_status || 'unknown'}
                    </span>
                  </div>

                  <div className="info-grid">
                    <div className="info-item">
                      <div className="info-label">Bridge patient</div>
                      <div className="info-value mono">
                        {selectedBridge?.patient_id ? truncateId(selectedBridge.patient_id) : '—'}
                      </div>
                    </div>
                    <div className="info-item">
                      <div className="info-label">Bridge strength</div>
                      <div className="info-value">
                        {selectedBridge?.status_of_bridge || selectedDonor.donor_category || '—'}
                      </div>
                    </div>
                    <div className="info-item">
                      <div className="info-label">Bridge donations</div>
                      <div className="info-value">{selectedBridge?.donations_till_date ?? '—'}</div>
                    </div>
                    <div className="info-item">
                      <div className="info-label">Previous interactions</div>
                      <div className="info-value">{history.length}</div>
                    </div>
                  </div>

                  <div className="response-tracker">
                    <div className="waiting-text">
                      {recommendationReasons.length
                        ? recommendationReasons.join(' · ')
                        : 'Relationship context will appear after a patient is selected.'}
                    </div>
                  </div>
                </div>

                <div className="card mb-3">
                  <div className="section-header">
                    <div>
                      <h2>Conversation History</h2>
                      <p>Chronological donor thread loaded from the backend.</p>
                    </div>
                    <span className="badge badge-gray">{history.length} messages</span>
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="donor-patient-select">
                      Linked patient
                    </label>
                    <select
                      id="donor-patient-select"
                      className="form-input"
                      value={selectedPatientId}
                      onChange={(event) => setSelectedPatientId(event.target.value)}
                    >
                      <option value="">All linked patients</option>
                      {bridges.map((bridge) => (
                        <option key={bridge.patient_id} value={bridge.patient_id}>
                          {truncateId(bridge.patient_id)} {bridge.bridge_blood_group ? `· ${bridge.bridge_blood_group}` : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  {historyLoading ? (
                    <LoadingSpinner />
                  ) : historyError ? (
                    <EmptyState title="Conversation unavailable" message={historyError} />
                  ) : history.length ? (
                    <div className="chat-list" ref={historyRef}>
                      {history.map((item, index) => (
                        <div
                          key={`${item.timestamp || index}-${index}`}
                          className={`chat-bubble ${item.role === 'assistant' ? 'assistant' : 'user'}`}
                        >
                          <div className="chat-meta">
                            <span>{item.role === 'assistant' ? 'Assistant' : 'Coordinator'}</span>
                            <span>{formatDateTime(item.timestamp)}</span>
                            <span>{item.patient_id ? truncateId(item.patient_id) : '—'}</span>
                          </div>
                          <div>{item.message || '—'}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState title="No conversation history" message="Generate outreach or send a chat message to start the thread." />
                  )}
                </div>

                <div className="card mb-3">
                  <div className="section-header">
                    <div>
                      <h2>Outreach Generator</h2>
                      <p>Generate the personalised WhatsApp message from the backend, then edit it before sending.</p>
                    </div>
                    <span className="badge badge-yellow">GPT-4o</span>
                  </div>

                  <div className="form-group">
                    <label className="form-label" htmlFor="outreach-stage">
                      Stage selector
                    </label>
                    <select
                      id="outreach-stage"
                      className="form-input"
                      value={outreachStage}
                      onChange={(event) => setOutreachStage(event.target.value)}
                    >
                      {OUTREACH_STAGES.map((stage) => (
                        <option key={stage.value} value={stage.value}>
                          {stage.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="simulate-buttons mb-3">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={generateOutreach}
                      disabled={!selectedPatientId || outreachLoading}
                    >
                      {outreachLoading ? 'Generating...' : 'Generate Message'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-success"
                      onClick={() => sendChat(outreachDraft, 'outreach')}
                      disabled={!selectedPatientId || !outreachDraft.trim() || chatLoading}
                    >
                      Send Generated Message
                    </button>
                  </div>

                  <textarea
                    className="message-box"
                    value={outreachDraft}
                    onChange={(event) => setOutreachDraft(event.target.value)}
                    placeholder="Generate a message to edit it here before sending."
                  />
                  <div className="waiting-text mt-2">
                    {selectedPatientId
                      ? `Message will be sent for patient ${truncateId(selectedPatientId)}.`
                      : 'Select a linked patient to generate outreach.'}
                  </div>
                </div>

                <div className="card">
                  <div className="section-header">
                    <div>
                      <h2>Live Chat</h2>
                      <p>Continue the conversation directly through the backend chat endpoint.</p>
                    </div>
                    <span className={`badge ${currentStage ? 'badge-blue' : 'badge-gray'}`}>{currentStage || 'initial_outreach'}</span>
                  </div>

                  <textarea
                    className="message-box"
                    value={chatMessage}
                    onChange={(event) => setChatMessage(event.target.value)}
                    placeholder="Type a follow-up message..."
                  />
                  <div className="simulate-buttons mt-3">
                    <button
                      type="button"
                      className="btn btn-red"
                      onClick={() => sendChat(chatMessage, 'chat')}
                      disabled={!selectedPatientId || !chatMessage.trim() || chatLoading}
                    >
                      {chatLoading ? 'Sending...' : 'Send Message'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => refreshConversation()}
                      disabled={historyLoading}
                    >
                      Refresh History
                    </button>
                  </div>
                  {selectedPatientId ? (
                    <div className="waiting-text mt-2">
                      Chat is connected to {truncateId(selectedPatientId)}
                      {selectedBridge?.bridge_blood_group ? ` · ${selectedBridge.bridge_blood_group}` : ''}.
                    </div>
                  ) : (
                    <EmptyState title="No patient selected" message="Choose a linked patient to enable outreach and chat." />
                  )}
                </div>
              </>
            ) : null}
          </div>
        </aside>
      ) : null}
    </section>
  );
}

function formatScore(value) {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  const numeric = normalizeScore(value);
  if (Number.isNaN(numeric)) {
    return String(value);
  }

  return `${Math.round(numeric)}%`;
}

function reliabilityTone(value) {
  const numeric = normalizeScore(value);
  if (numeric >= 70) {
    return 'high';
  }
  if (numeric >= 40) {
    return 'mid';
  }
  return 'low';
}

function reliabilityWidth(value) {
  const numeric = normalizeScore(value);
  const bucket = Math.max(0, Math.min(100, Math.round(numeric / 10) * 10));
  return `rel-${bucket}`;
}

function normalizeScore(value) {
  const numeric = Number(value || 0);
  if (Number.isNaN(numeric)) {
    return 0;
  }
  if (numeric > 0 && numeric <= 1) {
    return numeric * 100;
  }
  return numeric;
}

function statusTone(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized.includes('active')) {
    return 'badge-green';
  }
  if (normalized.includes('inactive')) {
    return 'badge-gray';
  }
  return 'badge-yellow';
}
