import { useEffect, useMemo, useState } from 'react';
import { 
  getDonors, 
  getDonor, 
  getDonorBadges, 
  getDonorStreak, 
  getDonorImpact, 
  getDonorRank, 
  getDonorEligibilityCountdown, 
  updateDonor 
} from '../api.js';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import EmptyState from '../components/EmptyState.jsx';

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

export function CoordinatorDonors() {
  const [donors, setDonors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filter, setFilter] = useState('All');
  const [expanded, setExpanded] = useState({});
  const [donorDetails, setDonorDetails] = useState({});
  const [editForms, setEditForms] = useState({});
  const [savingStatus, setSavingStatus] = useState({});

  useEffect(() => {
    async function loadDonors() {
      try {
        const data = await getDonors({ limit: 300 });
        setDonors(Array.isArray(data) ? data : []);
      } catch (err) {
        setDonors([]);
      } finally {
        setLoading(false);
      }
    }

    loadDonors();
  }, []);

  const filteredDonors = useMemo(() => {
    const lower = searchTerm.trim().toLowerCase();
    let list = donors.slice();
    if (filter === 'Eligible') list = list.filter((d) => (d.eligibility_status || '').toLowerCase() === 'eligible');
    if (filter === 'Inactive') list = list.filter((d) => (d.user_donation_active_status || '').toLowerCase() !== 'active');
    if (filter === 'Bridge') list = list.filter((d) => (d.donor_category || '').toLowerCase() === 'bridge donor');
    if (lower) {
      list = list.filter((donor) => {
        return (
          (donor.blood_group || '').toLowerCase().includes(lower) || 
          String(donor.user_id || donor.donor_id || '').toLowerCase().includes(lower) ||
          (donor.donor_category || '').toLowerCase().includes(lower)
        );
      });
    }
    return list;
  }, [donors, searchTerm, filter]);

  function shortId(id) {
    if (!id) return 'unknown';
    const str = String(id);
    return str.length > 12 ? str.substring(0, 12) : str;
  }

  const totals = useMemo(() => {
    const total = donors.length;
    const eligible = donors.filter((d) => (d.eligibility_status || '').toLowerCase() === 'eligible').length;
    const inactive = donors.filter((d) => (d.user_donation_active_status || '').toLowerCase() !== 'active').length;
    const bridge = donors.filter((d) => (d.donor_category || '').toLowerCase() === 'bridge donor').length;
    return { total, eligible, inactive, bridge };
  }, [donors]);

  const toggleExpand = async (donorId) => {
    const isExpanding = !expanded[donorId];
    setExpanded((s) => ({ ...s, [donorId]: isExpanding }));
    
    if (isExpanding && !donorDetails[donorId]) {
      try {
        const [profile, badges, streak, impact, rank, countdown] = await Promise.all([
          getDonor(donorId),
          getDonorBadges(donorId),
          getDonorStreak(donorId),
          getDonorImpact(donorId),
          getDonorRank(donorId),
          getDonorEligibilityCountdown(donorId)
        ]);

        const profileData = profile?.donor || {};
        setDonorDetails((d) => ({ 
          ...d, 
          [donorId]: { 
            profile: profileData, 
            badges: badges?.badges || [], 
            streak: streak?.streak || {},
            impact: impact?.impact || {},
            rank: rank?.rank || {},
            countdown: countdown?.countdown || {}
          } 
        }));

        setEditForms((f) => ({
          ...f,
          [donorId]: {
            blood_group: profileData.blood_group || '',
            user_donation_active_status: profileData.user_donation_active_status || 'Active',
            donor_category: profileData.donor_category || 'Bridge Donor',
            inactive_trigger_comment: profileData.inactive_trigger_comment || '',
          }
        }));
      } catch (err) {
        console.error('Failed to load donor details:', err);
        setDonorDetails((d) => ({ 
          ...d, 
          [donorId]: { profile: null, badges: [], streak: {}, impact: {}, rank: {}, countdown: {} } 
        }));
      }
    }
  };

  const handleFieldChange = (donorId, field, value) => {
    setEditForms((f) => ({
      ...f,
      [donorId]: {
        ...f[donorId],
        [field]: value
      }
    }));
  };

  const handleSave = async (donorId) => {
    setSavingStatus((s) => ({ ...s, [donorId]: { saving: true, success: false, message: '' } }));
    try {
      const payload = editForms[donorId];
      const res = await updateDonor(donorId, payload);
      if (res?.success) {
        setSavingStatus((s) => ({ ...s, [donorId]: { saving: false, success: true, message: 'Profile updated successfully!' } }));
        
        // Update local donors state
        setDonors((prevDonors) => 
          prevDonors.map((d) => {
            const currentId = d.user_id ?? d.donor_id;
            if (currentId === donorId) {
              return {
                ...d,
                blood_group: payload.blood_group,
                user_donation_active_status: payload.user_donation_active_status,
                donor_category: payload.donor_category,
              };
            }
            return d;
          })
        );

        // Update local details state
        setDonorDetails((prevDetails) => {
          if (!prevDetails[donorId]) return prevDetails;
          return {
            ...prevDetails,
            [donorId]: {
              ...prevDetails[donorId],
              profile: {
                ...prevDetails[donorId].profile,
                blood_group: payload.blood_group,
                user_donation_active_status: payload.user_donation_active_status,
                donor_category: payload.donor_category,
                inactive_trigger_comment: payload.inactive_trigger_comment,
              }
            }
          };
        });
      } else {
        setSavingStatus((s) => ({ ...s, [donorId]: { saving: false, success: false, message: res?.error || 'Failed to update.' } }));
      }
    } catch (err) {
      setSavingStatus((s) => ({ ...s, [donorId]: { saving: false, success: false, message: err?.message || 'Error occurred.' } }));
    }
  };

  if (loading) {
    return <LoadingSpinner label="Loading donor network..." />;
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h2>Donor Network</h2>
        <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', borderBottom: '1px solid var(--border)', paddingBottom: '1rem' }}>
          <div><strong>Total donors:</strong> {totals.total}</div>
          <div><strong>Eligible now:</strong> <span style={{ color: 'var(--green)' }}>{totals.eligible}</span></div>
          <div><strong>Inactive:</strong> <span style={{ color: 'var(--accent)' }}>{totals.inactive}</span></div>
          <div><strong>Bridge donors:</strong> {totals.bridge}</div>
        </div>

        <div style={{ marginTop: '1.25rem', display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input 
            type="text" 
            className="input" 
            placeholder="Search by ID, blood group or category..." 
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{ maxWidth: '360px' }}
          />
          <div style={{ display: 'flex', gap: '0.35rem', background: '#f1f5f9', padding: '4px', borderRadius: '8px' }}>
            {['All', 'Eligible', 'Inactive', 'Bridge'].map((f) => (
              <button 
                key={f} 
                className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-ghost'}`}
                style={{ 
                  borderRadius: '6px', 
                  border: 'none', 
                  boxShadow: filter === f ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                  background: filter === f ? 'var(--accent)' : 'transparent',
                  color: filter === f ? 'white' : 'var(--text-body)'
                }}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!filteredDonors.length ? (
        <EmptyState title="No donors found" message="No donor records match the current filter or search criteria." />
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--bg-light)', borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '12px 16px', textAlign: 'left' }}>Donor ID</th>
                <th style={{ padding: '12px 16px', textAlign: 'left' }}>Blood Group</th>
                <th style={{ padding: '12px 16px', textAlign: 'left' }}>Eligibility</th>
                <th style={{ padding: '12px 16px', textAlign: 'left' }}>Category</th>
                <th style={{ padding: '12px 16px', textAlign: 'left' }}>Donations</th>
                <th style={{ padding: '12px 16px', textAlign: 'left' }}>Reliability</th>
              </tr>
            </thead>
            <tbody>
              {filteredDonors.map((donor) => {
                const donorId = donor.user_id ?? donor.donor_id;
                const isExpanded = !!expanded[donorId];
                const details = donorDetails[donorId];
                const form = editForms[donorId] || {};
                const saveState = savingStatus[donorId] || {};

                // Determine if form is dirty
                const isDirty = details?.profile ? (
                  form.blood_group !== details.profile.blood_group ||
                  form.user_donation_active_status !== details.profile.user_donation_active_status ||
                  form.donor_category !== details.profile.donor_category ||
                  form.inactive_trigger_comment !== (details.profile.inactive_trigger_comment || '')
                ) : false;

                const eligibilityLower = (donor.eligibility_status || '').toLowerCase();
                const activeLower = (donor.user_donation_active_status || '').toLowerCase();

                return (
                  <tr key={donorId} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td colSpan={6} style={{ padding: 0 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <tbody>
                          <tr 
                            onClick={() => toggleExpand(donorId)} 
                            style={{ cursor: 'pointer', background: isExpanded ? '#f8fafc' : 'transparent', transition: 'background 0.2s' }}
                          >
                            <td style={{ padding: '14px 16px', width: '25%', fontFamily: 'monospace', color: 'var(--text-heading)', fontWeight: 500 }}>
                              {shortId(donorId)}
                              <CopyButton text={donorId} />
                            </td>
                            <td style={{ padding: '14px 16px', width: '15%' }}>
                              <span style={{ fontWeight: 600 }}>{donor.blood_group || 'unknown'}</span>
                            </td>
                            <td style={{ padding: '14px 16px', width: '15%' }}>
                              <span className={`badge ${eligibilityLower === 'eligible' ? 'badge-success' : 'badge-danger'}`}>
                                {donor.eligibility_status || 'unknown'}
                              </span>
                            </td>
                            <td style={{ padding: '14px 16px', width: '15%' }}>
                              <span className="badge badge-muted" style={{ background: '#f1f5f9', color: '#475569' }}>
                                {donor.donor_category || 'General'}
                              </span>
                            </td>
                            <td style={{ padding: '14px 16px', width: '15%' }}>{donor.donations_till_date ?? 0}</td>
                            <td style={{ padding: '14px 16px', width: '15%' }}>
                              <span className="badge" style={{ background: '#edf2f7', color: 'var(--text-heading)', fontWeight: 600 }}>
                                {Math.round((donor.normalized_reliability_score || 0) * 100)}%
                              </span>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr>
                              <td colSpan={6} style={{ padding: '0 16px 20px 16px', background: '#f8fafc' }}>
                                {!details ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '1.5rem', justifyContent: 'center' }}>
                                    <div className="spinner"></div>
                                    <span style={{ color: 'var(--text-label)' }}>Loading comprehensive donor intelligence...</span>
                                  </div>
                                ) : (
                                  <div style={{
                                    padding: '1.5rem',
                                    background: 'white',
                                    borderRadius: '8px',
                                    border: '1px solid var(--border)',
                                    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.05)'
                                  }}>
                                    {/* Intelligence Dashboard Grid */}
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.5rem' }}>
                                      
                                      {/* Core Info & Editor */}
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', borderRight: '1px solid #edf2f7', paddingRight: '1.25rem' }}>
                                        <h4 style={{ fontSize: '0.9rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 0.5rem 0' }}>
                                          ✏️ Update Core Profile
                                        </h4>
                                        <div>
                                          <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-label)', marginBottom: '0.25rem', display: 'block' }}>Blood Group</label>
                                          <select 
                                            value={form.blood_group || ''} 
                                            onChange={(e) => handleFieldChange(donorId, 'blood_group', e.target.value)}
                                            style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                                          >
                                            <option value="A Positive">A Positive</option>
                                            <option value="A Negative">A Negative</option>
                                            <option value="B Positive">B Positive</option>
                                            <option value="B Negative">B Negative</option>
                                            <option value="O Positive">O Positive</option>
                                            <option value="O Negative">O Negative</option>
                                            <option value="AB Positive">AB Positive</option>
                                            <option value="AB Negative">AB Negative</option>
                                          </select>
                                        </div>
                                        <div>
                                          <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-label)', marginBottom: '0.25rem', display: 'block' }}>Active Status</label>
                                          <select 
                                            value={form.user_donation_active_status || ''} 
                                            onChange={(e) => handleFieldChange(donorId, 'user_donation_active_status', e.target.value)}
                                            style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                                          >
                                            <option value="Active">Active</option>
                                            <option value="Inactive">Inactive</option>
                                          </select>
                                        </div>
                                        {form.user_donation_active_status === 'Inactive' && (
                                          <div>
                                            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-label)', marginBottom: '0.25rem', display: 'block' }}>Inactive Reason</label>
                                            <input 
                                              type="text"
                                              value={form.inactive_trigger_comment || ''} 
                                              onChange={(e) => handleFieldChange(donorId, 'inactive_trigger_comment', e.target.value)}
                                              placeholder="e.g. Temporarily out of town"
                                              style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                                            />
                                          </div>
                                        )}
                                        <div>
                                          <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-label)', marginBottom: '0.25rem', display: 'block' }}>Donor Category</label>
                                          <select 
                                            value={form.donor_category || ''} 
                                            onChange={(e) => handleFieldChange(donorId, 'donor_category', e.target.value)}
                                            style={{ padding: '6px 10px', fontSize: '0.85rem' }}
                                          >
                                            <option value="Bridge Donor">Bridge Donor</option>
                                            <option value="Emergency Donor">Emergency Donor</option>
                                            <option value="Guest">Guest</option>
                                            <option value="Volunteer">Volunteer</option>
                                          </select>
                                        </div>
                                        <button 
                                          onClick={() => handleSave(donorId)}
                                          disabled={saveState.saving || !isDirty}
                                          className="btn btn-primary btn-sm"
                                          style={{ marginTop: '0.5rem', width: '100%' }}
                                        >
                                          {saveState.saving ? 'Saving...' : 'Save Updates'}
                                        </button>
                                        {saveState.message && (
                                          <span style={{ fontSize: '0.75rem', color: saveState.success ? 'var(--green)' : 'var(--accent)', textAlign: 'center', marginTop: '0.25rem', fontWeight: 500 }}>
                                            {saveState.message}
                                          </span>
                                        )}
                                      </div>

                                      {/* Performance & Streak */}
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', borderRight: '1px solid #edf2f7', paddingRight: '1.25rem' }}>
                                        <h4 style={{ fontSize: '0.9rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 0.5rem 0' }}>
                                          📈 Performance Metrics
                                        </h4>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f8fafc', paddingBottom: '0.25rem' }}>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem' }}>Reliability Rank:</span>
                                          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{details.rank?.percentile || '—'}</span>
                                        </div>
                                        <div>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem', display: 'block', marginBottom: '0.25rem' }}>Reliability Rating:</span>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                            <div className="progress-track" style={{ flex: 1, margin: 0, height: '8px', background: '#e2e8f0' }}>
                                              <div className="progress-fill" style={{ width: `${Math.round((details.profile?.normalized_reliability_score || 0) * 100)}%`, background: 'var(--green)' }}></div>
                                            </div>
                                            <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{Math.round((details.profile?.normalized_reliability_score || 0) * 100)}%</span>
                                          </div>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f8fafc', paddingBottom: '0.25rem' }}>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem' }}>Total Calls / Donations:</span>
                                          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{details.profile?.total_calls ?? 0} / {details.profile?.donations_till_date ?? 0}</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f8fafc', paddingBottom: '0.25rem' }}>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem' }}>Current Streak:</span>
                                          <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--yellow)' }}>🔥 {details.streak?.current_streak ?? 0} cycle(s)</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f8fafc', paddingBottom: '0.25rem' }}>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem' }}>Max Streak:</span>
                                          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{details.streak?.longest_streak ?? 0} cycle(s)</span>
                                        </div>
                                        <div>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem', display: 'block' }}>Next Eligible:</span>
                                          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                                            {details.profile?.next_eligible_date ? new Date(details.profile.next_eligible_date).toLocaleDateString() : 'Eligible now'}
                                            {details.countdown?.days_until_eligible > 0 && (
                                              <span style={{ color: 'var(--accent)', marginLeft: '0.35rem' }}>({details.countdown.days_until_eligible} days left)</span>
                                            )}
                                          </span>
                                        </div>
                                      </div>

                                      {/* AI Behavioral Insights */}
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem', borderRight: '1px solid #edf2f7', paddingRight: '1.25rem' }}>
                                        <h4 style={{ fontSize: '0.9rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 0.5rem 0' }}>
                                          🧠 AI Behavioral Insights
                                        </h4>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f8fafc', paddingBottom: '0.25rem' }}>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem' }}>Motivation:</span>
                                          <span style={{ background: '#eef2ff', color: '#4f46e5', padding: '2px 6px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase' }}>
                                            {details.profile?.personality?.motivation_type || 'ALTURISTIC'}
                                          </span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f8fafc', paddingBottom: '0.25rem' }}>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem' }}>Tone Preference:</span>
                                          <span style={{ background: '#f5f3ff', color: '#7c3aed', padding: '2px 6px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase' }}>
                                            {details.profile?.personality?.communication_style || 'CASUAL'}
                                          </span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f8fafc', paddingBottom: '0.25rem' }}>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem' }}>Response Rate:</span>
                                          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                                            {details.profile?.personality?.response_rate !== undefined ? `${Math.round(details.profile.personality.response_rate * 100)}%` : '—'}
                                          </span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f8fafc', paddingBottom: '0.25rem' }}>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem' }}>Avg Response Speed:</span>
                                          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                                            {details.profile?.personality?.avg_response_time_hours !== undefined ? `${details.profile.personality.avg_response_time_hours} hrs` : '—'}
                                          </span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f8fafc', paddingBottom: '0.25rem' }}>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem' }}>Preferred Contact:</span>
                                          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{details.profile?.personality?.preferred_contact_time || '—'}</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f8fafc', paddingBottom: '0.25rem' }}>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem' }}>Last Contacted:</span>
                                          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                                            {details.profile?.last_contacted_date ? new Date(details.profile.last_contacted_date).toLocaleDateString() : 'Never'}
                                          </span>
                                        </div>
                                      </div>

                                      {/* Altruistic Impact & Badges */}
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                                        <h4 style={{ fontSize: '0.9rem', color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 0.5rem 0' }}>
                                          ❤️ Altruistic Impact
                                        </h4>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed #e2e8f0', paddingBottom: '0.35rem' }}>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem' }}>Lives Impacted:</span>
                                          <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--green)' }}>{details.impact?.lives_impacted ?? 0}</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed #e2e8f0', paddingBottom: '0.35rem' }}>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem' }}>Total Blood Units:</span>
                                          <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{details.impact?.total_units ?? 0} units</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed #e2e8f0', paddingBottom: '0.35rem' }}>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem' }}>Years Active:</span>
                                          <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{details.impact?.years_active ?? 0} yrs</span>
                                        </div>
                                        <div>
                                          <span style={{ color: 'var(--text-label)', fontSize: '0.8rem', display: 'block', marginBottom: '0.35rem' }}>Achievement Badges:</span>
                                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                                            {details.badges?.filter(b => b.earned).map(b => (
                                              <span 
                                                key={b.name} 
                                                className="badge badge-success" 
                                                title={b.description}
                                                style={{ fontSize: '0.75rem', padding: '3px 8px', cursor: 'help', background: 'var(--green-dim)', color: 'var(--green)', border: '1px solid rgba(39, 174, 96, 0.2)' }}
                                              >
                                                🏆 {b.name}
                                              </span>
                                            ))}
                                            {(!details.badges || details.badges.filter(b => b.earned).length === 0) && (
                                              <span style={{ color: 'var(--text-label)', fontStyle: 'italic', fontSize: '0.8rem' }}>No badges earned yet</span>
                                            )}
                                          </div>
                                        </div>
                                      </div>

                                    </div>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
