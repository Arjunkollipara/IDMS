import { useEffect, useMemo, useRef, useState } from 'react';
import EmptyState from '../components/EmptyState';
import LoadingSpinner from '../components/LoadingSpinner';
import SkeletonCard from '../components/SkeletonCard';
import { encodeId } from '../api';

// Temporary runtime debugging flags — set to false to disable sections while testing
const ENABLE_RECOMMENDATION_SUMMARY = false;
const ENABLE_RECOMMENDATION_EVIDENCE = false;
const ENABLE_OUTREACH_UI = false;

const DEFAULT_API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

function Actions({ notify = () => {}, apiBase = DEFAULT_API_BASE }) {
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [selectedPatient, setSelectedPatient] = useState(null);
  const [eligibleDonors, setEligibleDonors] = useState([]);
  const [rankedDonors, setRankedDonors] = useState([]);
  const [recommendedDonor, setRecommendedDonor] = useState(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [draftMessage, setDraftMessage] = useState('');
  const [selectedDonorId, setSelectedDonorId] = useState(null);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [tracker, setTracker] = useState('Select a patient to start an action.');
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [emergencyForm, setEmergencyForm] = useState({ required_date: '', reason: '' });
  const [saving, setSaving] = useState(false);
  const notifyRef = useRef(notify);

  useEffect(() => {
    notifyRef.current = notify;
  }, [notify]);

  useEffect(() => {
    let mounted = true;

    async function loadPatients() {
      try {
        setLoading(true);
        setError('');
        const response = await fetch(`${apiBase}/patients?limit=100`);
        const payload = await response.json();

        if (!mounted) {
          return;
        }

        if (!response.ok || payload.success === false) {
          throw new Error(payload.error || 'Failed to load patients');
        }

        setPatients(payload.patients || []);
      } catch (err) {
        if (mounted) {
          setError(err.message);
          notifyRef.current(err.message, 'error');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    loadPatients();

    return () => {
      mounted = false;
    };
  }, [apiBase]);

  const actionablePatients = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return [...patients]
      .map((patient) => {
        const days = daysUntil(patient.expected_next_transfusion_date);
        const tone = actionTone(days);
        return { ...patient, days, tone };
      })
      .filter((patient) => {
        const matchesText =
          !needle ||
          [patient.patient_id, patient.blood_group, patient.status]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(needle));

        const matchesFilter = filter === 'all' || patient.tone === filter;
        return matchesText && matchesFilter;
      })
      .sort((left, right) => left.days - right.days);
  }, [filter, patients, query]);

  const actionCounts = useMemo(() => {
    return actionablePatients.reduce(
      (acc, patient) => {
        acc[patient.tone] += 1;
        return acc;
      },
      { urgent: 0, approaching: 0, scheduled: 0 },
    );
  }, [actionablePatients]);

  useEffect(() => {
    if (!selectedId) {
      setSelectedPatient(null);
      setEligibleDonors([]);
      setRecommendedDonor(null);
      setSelectedDonorId(null);
      setDraftMessage('');
      return;
    }

    let mounted = true;

    async function loadActionDetail() {
      try {
        setDrawerLoading(true);
        setTracker('Loading action detail...');

        const encodedSelectedId = encodeId(selectedId);
        const patientUrl = `${apiBase}/patients/${encodedSelectedId}`;
        const eligibleUrl = `${apiBase}/eligible/${encodedSelectedId}`;
        console.debug("[Actions] detail requests", { selectedId, patientUrl, eligibleUrl });

        const patientResponsePromise = fetch(patientUrl);
        const eligibleResponsePromise = fetch(eligibleUrl);
        const rankedUrl = `${apiBase}/ranked/${encodedSelectedId}`;
        const rankedResponsePromise = fetch(rankedUrl);
        const patientResponse = await patientResponsePromise;
        const patientPayload = await patientResponse.json();

        if (!mounted) {
          return;
        }

        if (!patientResponse.ok || patientPayload.success === false) {
          throw new Error(patientPayload.error || 'Failed to load patient');
        }

        const patient = patientPayload.patient || null;

        setSelectedPatient(patient);
        setTracker('Loading eligible donors...');

        const eligibleResponse = await eligibleResponsePromise;
        const eligiblePayload = await eligibleResponse.json();
        const rankedResponse = await rankedResponsePromise;
        const rankedPayload = await rankedResponse.json();

        if (!mounted) {
          return;
        }

        const rankedList = Array.isArray(rankedPayload.ranked_donors)
          ? rankedPayload.ranked_donors
          : Array.isArray(rankedPayload.top_5)
          ? rankedPayload.top_5
          : [];
        setRankedDonors(rankedList);

        const donors = extractDonors(eligiblePayload);
        const topDonor = donors[0] || null;

        setEligibleDonors(donors);
        setRecommendedDonor(topDonor);
        setSelectedDonorId(topDonor?.id || topDonor?.donor_id || topDonor?.user_id || null);
        setDraftMessage(buildDraftMessage(patient, topDonor));
        setTracker(
          donors.length
            ? `Loaded ${donors.length} eligible donors. Ready to send outreach.`
            : 'No eligible donors returned by the backend.',
        );
      } catch (err) {
        if (mounted) {
          notifyRef.current(err.message, 'error');
          setTracker(err.message);
        }
      } finally {
        if (mounted) {
          setDrawerLoading(false);
        }
      }
    }

    loadActionDetail();

    return () => {
      mounted = false;
    };
  }, [apiBase, selectedId]);

  function closeDrawer() {
    setSelectedId(null);
  }

  async function runOutreach() {
    if (!selectedId) {
      return;
    }

    const stage = selectedPatient ? outreachStage(selectedPatient) : 1;

    try {
      setTracker('Generating outreach message...');
      const outreachUrl = `${apiBase}/outreach/${encodeId(selectedId)}/${stage}`;
      console.debug("[Actions] outreach request", { selectedId, outreachUrl, stage });
      const response = await fetch(outreachUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ language_code: 'en', draft_only: true }),
      });
      const payload = await response.json();

      if (!response.ok || payload.success === false || payload.error) {
        throw new Error(payload.error || 'Failed to generate outreach');
      }

      const nextMessage =
        payload.sample_message ||
        payload.message ||
        payload.generated_message ||
        buildDraftMessage(selectedPatient, recommendedDonor);

      setDraftMessage(nextMessage);
      setTracker(payload.message || `Outreach draft generated for stage ${stage}.`);
      notifyRef.current('Outreach draft generated', 'success');
    } catch (err) {
      setTracker(err.message);
      notifyRef.current(err.message, 'error');
    }
  }

  async function sendDraftMessage() {
    if (!selectedId || !selectedPatient || !selectedDonorId || !draftMessage.trim()) {
      notifyRef.current('Select a donor and edit the draft before sending.', 'warning');
      return;
    }

    try {
      setSendingMessage(true);
      setTracker('Sending coordinator message...');
      const response = await fetch(`${apiBase}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          donor_id: selectedDonorId,
          patient_id: selectedId,
          message: draftMessage.trim(),
        }),
      });
      const payload = await response.json();

      if (!response.ok || payload.error) {
        throw new Error(payload.error || 'Failed to send message');
      }

      setTracker('Message sent to donor.');
      notifyRef.current('Message sent', 'success');
    } catch (err) {
      setTracker(err.message);
      notifyRef.current(err.message, 'error');
    } finally {
      setSendingMessage(false);
    }
  }

  const selectedDonor = useMemo(
    () =>
      eligibleDonors.find(
        (donor) => donor.id === selectedDonorId || donor.donor_id === selectedDonorId || donor.user_id === selectedDonorId,
      ),
    [eligibleDonors, selectedDonorId],
  );

  const selectedDonorRank = useMemo(() => {
    if (!selectedDonorId || rankedDonors.length === 0) {
      return null;
    }
    const index = rankedDonors.findIndex(
      (donor) => donor.donor_id === selectedDonorId || donor.user_id === selectedDonorId || donor.id === selectedDonorId,
    );
    return index >= 0 ? index + 1 : null;
  }, [rankedDonors, selectedDonorId]);

  const recommendationReasons = useMemo(() => {
    if (!selectedDonor) return [];
    const reasons = [];
    const score = Number(selectedDonor.normalized_reliability_score ?? selectedDonor.score ?? 0);
    const donations = Number(selectedDonor.donations_till_date ?? selectedDonor.donations ?? 0);
    const eligibility = String(
      selectedDonor.eligibility_status ?? selectedDonor.user_donation_active_status ?? '',
    ).toLowerCase();
    if (selectedDonorRank === 1) {
      reasons.push('Top ranked donor for this patient');
    }
    if (donations > 0) {
      reasons.push('Previous donations for this patient');
    }
    if (score >= 70) {
      reasons.push('High reliability');
    }
    if (eligibility.includes('eligible') || eligibility.includes('active')) {
      reasons.push('Currently eligible');
    }
    if (selectedDonor.donor_category) {
      reasons.push(`${selectedDonor.donor_category} donor`);
    }
    return reasons;
  }, [selectedDonor, selectedDonorRank]);

  const recommendationEvidence = useMemo(() => {
    if (!selectedDonor) return [];
    const evidence = [];
    const donations = selectedDonor.donations_till_date ?? selectedDonor.donations ?? null;
    const reliability = selectedDonor.normalized_reliability_score ?? selectedDonor.score ?? null;
    const lastDonation = selectedDonor.last_donation_date ?? selectedDonor.last_donation;
    const distance = selectedDonor.distance_km ?? selectedDonor.distance;
    const eligibility = selectedDonor.eligibility_status ?? selectedDonor.user_donation_active_status;
    if (donations != null) {
      evidence.push(`Donated ${donations} time${donations === 1 ? '' : 's'} for this patient`);
    }
    if (reliability != null) {
      evidence.push(`Reliability score ${Math.round(Number(reliability))}%`);
    }
    if (lastDonation) {
      evidence.push(`Last donation date ${formatDate(lastDonation)}`);
    }
    if (eligibility) {
      evidence.push(`Eligible status: ${String(eligibility)}`);
    }
    if (selectedDonor.donor_category) {
      evidence.push(`Donor category: ${selectedDonor.donor_category}`);
    }
    if (distance != null) {
      evidence.push(`Distance: ${distance} km`);
    }
    return evidence;
  }, [selectedDonor]);

  async function runSonar() {
    if (!selectedId) {
      return;
    }

    try {
      setTracker('Sending sonar ping...');
      const sonarUrl = `${apiBase}/sonar/${encodeURIComponent(String(selectedId))}`;
      console.debug("[Actions] sonar request", { selectedId, sonarUrl });
      const response = await fetch(sonarUrl, {
        method: 'POST',
      });
      const payload = await response.json();

      if (!response.ok || payload.success === false || payload.error) {
        throw new Error(payload.error || 'Failed to send sonar ping');
      }

      setTracker(`Sonar pings sent: ${payload.pings_sent ?? 0}`);
      notifyRef.current('Sonar ping sent', 'success');
    } catch (err) {
      setTracker(err.message);
      notifyRef.current(err.message, 'error');
    }
  }

  async function submitEmergency(event) {
    event.preventDefault();
    if (!selectedId || !emergencyForm.required_date) {
      return;
    }

    try {
      setSaving(true);
      const emergencyUrl = `${apiBase}/emergency/${encodeURIComponent(String(selectedId))}`;
      console.debug("[Actions] emergency request", { selectedId, emergencyUrl });
      const response = await fetch(emergencyUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(emergencyForm),
      });
      const payload = await response.json();

      if (!response.ok || payload.success === false) {
        throw new Error(payload.error || 'Failed to declare emergency');
      }

      notifyRef.current(payload.message || 'Emergency declared', 'success');
      setEmergencyOpen(false);
      setTracker(payload.message || 'Emergency declared.');
    } catch (err) {
      notifyRef.current(err.message, 'error');
      setTracker(err.message);
    } finally {
      setSaving(false);
    }
  }

  function openEmergency() {
    setEmergencyForm({
      required_date: selectedPatient?.expected_next_transfusion_date?.slice?.(0, 10) || '',
      reason: '',
    });
    setEmergencyOpen(true);
  }

  return (
    <section>
      <div className="section-header">
        <div>
          <h1>Actions</h1>
          <p>Urgency queue with donor suggestions and outbound controls.</p>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-card red">
          <div className="stat-number">{actionCounts.urgent}</div>
          <div className="stat-label">Urgent</div>
          <div className="stat-sub">Due in 3 days or less</div>
        </div>
        <div className="stat-card yellow">
          <div className="stat-number">{actionCounts.approaching}</div>
          <div className="stat-label">Approaching</div>
          <div className="stat-sub">Due within a week</div>
        </div>
        <div className="stat-card green">
          <div className="stat-number">{actionCounts.scheduled}</div>
          <div className="stat-label">Scheduled</div>
          <div className="stat-sub">Further out</div>
        </div>
      </div>

      <div className="filter-bar">
        <input
          className="search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search patient actions"
        />

        <div className="filter-pills">
          {[
            { id: 'all', label: 'All' },
            { id: 'urgent', label: 'Urgent' },
            { id: 'approaching', label: 'Approaching' },
            { id: 'scheduled', label: 'Scheduled' },
          ].map((option) => (
            <button
              key={option.id}
              type="button"
              className={`pill ${filter === option.id ? 'active' : ''}`}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <SkeletonCard lines={4} />
      ) : error ? (
        <div className="card">
          <EmptyState title="Actions unavailable" message={error} />
        </div>
      ) : actionablePatients.length === 0 ? (
        <div className="card">
          <EmptyState title="No actions found" message="No patients match the current filters." />
        </div>
      ) : (
        <div className="action-list">
          {actionablePatients.map((patient) => {
            const donor = recommendedLabel(patient);
            return (
              <div
                key={patient.patient_id}
                className={`action-card ${patient.tone}`}
                onClick={() => setSelectedId(patient.patient_id)}
              >
                <div className="action-days">
                  <div className="action-days-number">{patient.days}</div>
                  <div className="action-days-label">Days</div>
                </div>

                <div className="action-patient">
                  <div className="action-patient-label">Patient</div>
                  <div className="action-patient-id">{patient.patient_id}</div>
                  <span className={`badge ${cardBadgeTone(patient.tone)}`}>{patient.blood_group || 'Unknown'}</span>
                </div>

                <div className="action-donor">
                  <div className="action-donor-label">Suggested Donor</div>
                  <div className="action-donor-id">
                    {donor.id}
                  </div>
                  <div className="score-bar-wrap">
                    <div className="score-bar">
                      <div className={`score-bar-fill ${donor.scoreTone} ${donor.scoreWidth || 'rel-70'}`} />
                    </div>
                    <span className="score-text">{donor.scoreText}</span>
                  </div>
                </div>

                <div className="action-buttons">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm full-width"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedId(patient.patient_id);
                    }}
                  >
                    Review
                  </button>
                  <button
                    type="button"
                    className="btn btn-red btn-sm full-width"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedId(patient.patient_id);
                    }}
                  >
                    Open
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selectedId ? <div className="overlay" onClick={closeDrawer} /> : null}

      {selectedId ? (
        <aside className="drawer" aria-label="Action drawer">
          <div className="drawer-header">
            <div>
              <h2>{selectedPatient?.patient_id || selectedId}</h2>
              <p>Outreach draft, eligible donors, and escalation tools.</p>
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
            ) : selectedPatient ? (
              <>
                <div className="info-grid">
                  <div className="info-item">
                    <div className="info-label">Patient ID</div>
                    <div className="info-value mono">{selectedPatient.patient_id || '—'}</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Blood Group</div>
                    <div className="info-value">{selectedPatient.blood_group || '—'}</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Frequency</div>
                    <div className="info-value">{selectedPatient.frequency_in_days ?? '—'} days</div>
                  </div>
                  <div className="info-item">
                    <div className="info-label">Next Due</div>
                    <div className="info-value">{formatDate(selectedPatient.expected_next_transfusion_date)}</div>
                  </div>
                </div>

                {ENABLE_RECOMMENDATION_SUMMARY && selectedDonor ? (
                  <div className="card-sm mb-3">
                    <div className="section-title mb-2">Recommendation Summary</div>
                    <div>
                      <strong>
                        {selectedDonorRank === 1
                          ? 'This donor is ranked #1 for this patient.'
                          : selectedDonorRank
                          ? `This donor is ranked #${selectedDonorRank} for this patient.`
                          : 'This donor is recommended for this patient.'}
                      </strong>
                    </div>
                    {recommendationReasons.length ? (
                      <ul className="bullet-list mt-2">
                        {recommendationReasons.map((reason, index) => (
                          <li key={index}>{reason}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted mt-2">Recommendation is based on eligibility and donor history.</p>
                    )}
                  </div>

                ) : null}

                {ENABLE_RECOMMENDATION_EVIDENCE && selectedDonor ? (
                  <div className="card-sm mb-3">
                    <div className="section-title mb-2">Why This Donor Was Recommended</div>
                    {recommendationEvidence.length ? (
                      <ul className="bullet-list mt-2">
                        {recommendationEvidence.map((item, index) => (
                          <li key={index}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted">No additional evidence is available for this donor.</p>
                    )}
                  </div>
                ) : null}

                <div className="divider" />

                <div className="card-sm mb-3">
                  <div className="section-title mb-2">Eligible donors</div>
                  {eligibleDonors.length === 0 ? (
                    <p>No donors returned for this patient.</p>
                  ) : (
                    <>
                      <label className="form-label" htmlFor="donor-select">
                        Send draft to
                      </label>
                      <select
                        id="donor-select"
                        className="form-input"
                        value={selectedDonorId || ''}
                        onChange={(event) => setSelectedDonorId(event.target.value || null)}
                      >
                        <option value="">Select a donor</option>
                        {eligibleDonors.map((donor, index) => (
                          <option
                            key={`${donor.id || donor.donor_id || index}`}
                            value={donor.id || donor.donor_id || donor.user_id || ''}
                          >
                            {renderDonorLabel(donor)}
                          </option>
                        ))}
                      </select>

                      <div className="mt-3">
                        {eligibleDonors.slice(0, 4).map((donor, index) => (
                          <div key={`${donor.id || donor.donor_id || index}`} className="flex justify-between gap-3">
                            <span className="text-mono">{renderDonorLabel(donor)}</span>
                            <span className="text-muted">{donor.scoreText || donor.score || donor.normalized_reliability_score || '—'}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="draft-message">
                    AI Draft Message
                  </label>
                  <textarea
                    id="draft-message"
                    className="message-box"
                    value={draftMessage}
                    onChange={(event) => setDraftMessage(event.target.value)}
                    placeholder="Generate an outreach draft and edit it here before sending."
                  />
                </div>

                <div className="response-tracker">
                  <div className="waiting-text">{tracker}</div>
                  <div className="simulate-buttons">
                    <button type="button" className="btn btn-ghost" onClick={runOutreach}>
                      Generate draft
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={runSonar}>
                      Send sonar
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={openEmergency}>
                      Emergency
                    </button>
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <div className="drawer-footer">
            <div className="simulate-buttons">
              <button type="button" className="btn btn-ghost" onClick={runOutreach}>
                Generate draft
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={sendDraftMessage}
                disabled={!selectedDonorId || !draftMessage.trim() || sendingMessage}
              >
                {sendingMessage ? 'Sending...' : 'Send message'}
              </button>
              <button type="button" className="btn btn-red" onClick={runSonar}>
                Sonar
              </button>
            </div>
          </div>
        </aside>
      ) : null}

      {emergencyOpen ? (
        <div className="modal-overlay" onClick={() => setEmergencyOpen(false)}>
          <div className="modal emergency-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h2>Declare emergency</h2>
              <button type="button" className="close-btn" onClick={() => setEmergencyOpen(false)}>
                ×
              </button>
            </div>

            <form onSubmit={submitEmergency}>
              <div className="modal-body">
                <div className="warning-box">
                  This updates the patient record and triggers stage 3 escalation.
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="required_date">
                    Required date
                  </label>
                  <input
                    id="required_date"
                    className="form-input"
                    type="date"
                    value={emergencyForm.required_date}
                    onChange={(event) =>
                      setEmergencyForm((current) => ({ ...current, required_date: event.target.value }))
                    }
                  />
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="reason">
                    Reason
                  </label>
                  <textarea
                    id="reason"
                    className="form-input"
                    value={emergencyForm.reason}
                    onChange={(event) =>
                      setEmergencyForm((current) => ({ ...current, reason: event.target.value }))
                    }
                    placeholder="Optional note for the escalation log"
                  />
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setEmergencyOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-red" disabled={saving}>
                  {saving ? 'Saving...' : 'Declare emergency'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function actionTone(days) {
  if (days <= 3) {
    return 'urgent';
  }
  if (days <= 7) {
    return 'approaching';
  }
  return 'scheduled';
}

function cardBadgeTone(tone) {
  if (tone === 'urgent') {
    return 'badge-red';
  }
  if (tone === 'approaching') {
    return 'badge-yellow';
  }
  return 'badge-green';
}

function daysUntil(value) {
  if (!value) {
    return 30;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 30;
  }

  const diff = date.getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86400000));
}

function formatDate(value) {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  }).format(date);
}

function extractDonors(payload) {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload.map(normalizeDonor).filter(Boolean);
  }

  const arrays = Object.values(payload).filter(Array.isArray);
  if (arrays.length) {
    return arrays.flat().map(normalizeDonor).filter(Boolean);
  }

  if (payload.donors && Array.isArray(payload.donors)) {
    return payload.donors.map(normalizeDonor).filter(Boolean);
  }

  return [];
}

function normalizeDonor(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const id = item.donor_id || item.user_id || item.id;
  if (!id) {
    return null;
  }

  const numericScore = Number(
    item.normalized_reliability_score ?? item.score ?? item.reliability_score ?? item.match_score ?? 0,
  );

  return {
    ...item,
    id,
    score: Number.isNaN(numericScore) ? 0 : numericScore,
    scoreText: Number.isNaN(numericScore) ? '—' : `${Math.round(numericScore)}%`,
    scoreTone: donorTone(numericScore),
    scoreWidth: scoreWidth(numericScore),
  };
}

function donorTone(score) {
  if (score >= 70) {
    return 'high';
  }
  if (score >= 40) {
    return 'mid';
  }
  return 'low';
}

function scoreWidth(score) {
  const numeric = Number(score || 0);
  const bucket = Math.max(0, Math.min(100, Math.round(numeric / 10) * 10));
  return `rel-${bucket}`;
}

function buildDraftMessage(patient, donor) {
  const donorName = donor?.donor_name || donor?.name || donor?.display_name || 'friend';
  const patientName = patient?.patient_name || 'a patient';
  const bloodGroup = patient?.blood_group ? `${patient.blood_group} blood` : 'blood';
  return `Hi ${donorName}, we have a request for ${bloodGroup} for ${patientName}. Would you be available to help?`;
}

function renderDonorLabel(donor) {
  if (!donor || typeof donor !== 'object') {
    return 'Donor';
  }
  return donor.donor_name || donor.name || donor.display_name || donor.user_id || donor.donor_id || donor.id || 'Donor';
}

function outreachStage(patient) {
  const days = daysUntil(patient?.expected_next_transfusion_date);
  if (days <= 3) {
    return 3;
  }
  if (days <= 7) {
    return 2;
  }
  return 1;
}

function recommendedLabel(patient) {
  const patientId = patient?.patient_id || 'patient';
  const bloodGroup = patient?.blood_group || 'any';
  const text = `${patientId}-${bloodGroup}`;
  const score = Math.max(20, Math.min(95, 100 - (patient?.days || 0) * 3));
  return {
    id: text,
    scoreText: bloodGroup ? `${bloodGroup}` : 'Pending',
    scoreTone: donorTone(score),
    scoreWidth: scoreWidth(score),
  };
}

export default Actions;
export { Actions };
