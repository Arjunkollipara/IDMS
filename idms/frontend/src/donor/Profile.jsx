import { useEffect, useMemo, useState } from 'react';
import { getDonor, getDonorBadges, getDonorStreak, getDonorImpact, getDonorRank, updateDonor, getDonors } from '../api.js';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useToast } from '../components/Toast.jsx';

export function DonorProfile({ donorId, selectedDonorBloodGroup }) {
  const [donorProfile, setDonorProfile] = useState(null);
  const [badges, setBadges] = useState([]);
  const [streak, setStreak] = useState(null);
  const [impact, setImpact] = useState(null);
  const [rank, setRank] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({
    blood_group: '',
    gender: '',
    user_donation_active_status: '',
    donor_category: '',
    last_donation_date: '',
    next_eligible_date: '',
  });
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();
  const [donors, setDonors] = useState([]);
  const [selectedDonorId, setSelectedDonorId] = useState('');

  const activeDonorId = selectedDonorId || donorId;

  // Restore saved donor selection from localStorage
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

  // Persist selection changes to localStorage
  useEffect(() => {
    if (selectedDonorId) localStorage.setItem('idms_donor_id', selectedDonorId);
  }, [selectedDonorId]);

  // Load profile whenever activeDonorId changes
  useEffect(() => {
    if (!activeDonorId) {
      setLoading(false);
      return;
    }
    loadProfile();
  }, [activeDonorId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadProfile() {
      setLoading(true);
      try {
        const results = await Promise.allSettled([
          getDonor(activeDonorId),
          getDonorBadges(activeDonorId),
          getDonorStreak(activeDonorId),
          getDonorImpact(activeDonorId),
          getDonorRank(activeDonorId),
        ]);

        const profileResult = results[0];
        if (profileResult.status === 'fulfilled' && (profileResult.value?.donor || profileResult.value)) {
          const donor = profileResult.value.donor || profileResult.value;
          setDonorProfile(donor);
          setForm({
            blood_group: donor.blood_group || '',
            gender: donor.gender || '',
            user_donation_active_status: donor.user_donation_active_status || '',
            donor_category: donor.donor_category || '',
            last_donation_date: donor.last_donation_date || '',
            next_eligible_date: donor.next_eligible_date || '',
          });
        } else {
          console.error('Error loading donor profile:', profileResult.status === 'rejected' ? profileResult.reason : 'No donor data');
          setDonorProfile(null);
        }

        const badgesResult = results[1];
        setBadges(badgesResult.status === 'fulfilled' ? badgesResult.value?.badges || [] : []);

        const streakResult = results[2];
        setStreak(streakResult.status === 'fulfilled' ? streakResult.value?.streak || null : null);

        const impactResult = results[3];
        setImpact(impactResult.status === 'fulfilled' ? impactResult.value?.impact || null : null);

        const rankResult = results[4];
        setRank(rankResult.status === 'fulfilled' ? rankResult.value?.rank || null : null);
      } catch (err) {
        console.error('Unexpected error loading profile:', err);
      } finally {
        setLoading(false);
      }
    }



  const currentDonor = useMemo(() => donorProfile, [donorProfile]);
  const donorPersonality = currentDonor?.personality || {};
  const engagementScore = useMemo(() => {
    const reliability = Number(currentDonor?.normalized_reliability_score ?? 0);
    const responseRate = Number(donorPersonality.response_rate ?? 0);
    const donations = Number(currentDonor?.donations_till_date ?? 0);
    return Math.min(100, Math.round(reliability * 20 + responseRate * 30 + Math.min(donations, 8) * 4));
  }, [currentDonor, donorPersonality.response_rate]);

  const sentimentSummary = useMemo(() => {
    const history = Array.isArray(donorPersonality.sentiment_history) ? donorPersonality.sentiment_history : [];
    if (history.length === 0) return 'balanced';
    const average = history.reduce((sum, value) => sum + Number(value || 0), 0) / history.length;
    if (average >= 0.5) return 'positive';
    if (average <= -0.5) return 'cautious';
    return 'balanced';
  }, [donorPersonality.sentiment_history]);

  async function handleSave(event) {
    event.preventDefault();
    if (!activeDonorId) return;

    setSaving(true);
    try {
      await updateDonor(activeDonorId, {
        blood_group: form.blood_group,
        gender: form.gender,
        user_donation_active_status: form.user_donation_active_status,
        donor_category: form.donor_category,
        last_donation_date: form.last_donation_date || null,
        next_eligible_date: form.next_eligible_date || null,
      });
      showToast('Profile updated successfully.', 'success');
    } catch (err) {
      showToast('Unable to update donor profile.', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <LoadingSpinner label="Loading donor profile" />;
  }

  // If profile failed to load but we have basic info, show what we have
  // This prevents "Unable to load" errors and always shows useful information
  const displayDonor = currentDonor || {
    user_id: activeDonorId,
    name: activeDonorId,
    blood_group: currentDonor?.blood_group || selectedDonorBloodGroup || form.blood_group || 'unknown',
    eligibility_status: 'unknown',
    donor_category: 'unknown',
  };

  return (
    <div>
      <h2>{displayDonor.name ?? `Donor ${activeDonorId}`}</h2>
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
      <div className="card" style={{ marginBottom: '1rem' }}>
        <p>Donor ID: {activeDonorId}</p>
        <p>Blood type: {displayDonor.blood_group ?? 'unknown'}</p>
        <p>Category: {displayDonor.donor_category ?? 'unknown'}</p>
        <p>Eligibility: {displayDonor.eligibility_status ?? 'unknown'}</p>
        <p>Reliability: {displayDonor.normalized_reliability_score != null ? Math.round(displayDonor.normalized_reliability_score * 100) : '—'}%</p>
        <p>Total donations: {displayDonor.donations_till_date ?? '—'}</p>
        <p>Registration date: {displayDonor.registration_date ?? 'not available'}</p>
        <p>Last donation: {displayDonor.last_donation_date ?? 'not available'}</p>
        <p>Next eligible: {displayDonor.next_eligible_date ?? 'not available'}</p>
      </div>

      {streak && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3>Donation streak</h3>
          <div className="detail-grid">
            <div className="field-row">
              <span>Current streak</span>
              <strong>{streak.current_streak ?? 0} donations</strong>
            </div>
            <div className="field-row">
              <span>Longest streak</span>
              <strong>{streak.longest_streak ?? 0} donations</strong>
            </div>
          </div>
        </div>
      )}

      {impact && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3>Impact & reach</h3>
          <div className="detail-grid">
            <div className="field-row">
              <span>Lives impacted</span>
              <strong>{impact.lives_impacted ?? 0}</strong>
            </div>
            <div className="field-row">
              <span>Years active</span>
              <strong>{impact.years_active ?? 0}</strong>
            </div>
          </div>
        </div>
      )}

      {rank && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3>Donor ranking</h3>
          <div className="detail-grid">
            <div className="field-row">
              <span>Percentile rank</span>
              <strong>{rank.percentile ?? 'N/A'}</strong>
            </div>
          </div>
        </div>
      )}

      {badges && badges.length > 0 && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3>Earned badges</h3>
          <div className="badge-shelf">
            {badges.map((badge, idx) => (
              <span
                key={idx}
                className={`badge ${badge.earned ? 'badge-earned' : 'badge-locked'}`}
                title={badge.description || badge.name}
              >
                {badge.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {currentDonor && (
        <div className="card" style={{ marginBottom: '1rem' }}>
          <h3>Personality & engagement</h3>
          <div className="detail-grid">
            <div className="field-row">
              <strong>{donorId}</strong>
              <span>Engagement score</span>
              <strong>{engagementScore}%</strong>
            </div>
            <div className="field-row">
              <span>Communication style</span>
              <span className="badge badge-muted">{donorPersonality.communication_style || 'neutral'}</span>
            </div>
            <div className="field-row">
              <span>Motivation type</span>
              <span className="badge badge-muted">{donorPersonality.motivation_type || 'balanced'}</span>
            </div>
            <div className="field-row">
              <span>Response rate</span>
              <strong>{donorPersonality.response_rate != null ? `${(donorPersonality.response_rate * 100).toFixed(0)}%` : 'n/a'}</strong>
            </div>
            <div className="field-row">
              <span>Average response time</span>
              <strong>{donorPersonality.avg_response_time_hours != null ? `${donorPersonality.avg_response_time_hours.toFixed(1)}h` : 'n/a'}</strong>
            </div>
            <div className="field-row">
              <span>Sentiment</span>
              <span className="badge badge-muted">{sentimentSummary}</span>
            </div>
          </div>
        </div>
      )}

      {currentDonor && (
        <div className="card">
          <h3>Edit profile</h3>
          <form onSubmit={handleSave}>
            <div className="field-row">
              <label className="form-label" htmlFor="blood-group">
                Blood group
              </label>
              <input
                id="blood-group"
                className="form-input"
                value={form.blood_group}
                onChange={(event) => setForm((prev) => ({ ...prev, blood_group: event.target.value }))}
              />
            </div>

            <div className="field-row">
              <label className="form-label" htmlFor="gender">
                Gender
              </label>
              <input
                id="gender"
                className="form-input"
                value={form.gender}
                onChange={(event) => setForm((prev) => ({ ...prev, gender: event.target.value }))}
              />
            </div>

            <div className="field-row">
              <label className="form-label" htmlFor="status">
                Availability
              </label>
              <select
                id="status"
                className="form-input"
                value={form.user_donation_active_status}
                onChange={(event) => setForm((prev) => ({ ...prev, user_donation_active_status: event.target.value }))}
              >
                <option value="">Select status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>

            <div className="field-row">
              <label className="form-label" htmlFor="donor-category">
                Category
              </label>
              <input
                id="donor-category"
                className="form-input"
                value={form.donor_category}
                onChange={(event) => setForm((prev) => ({ ...prev, donor_category: event.target.value }))}
              />
            </div>

            <div className="field-row">
              <label className="form-label" htmlFor="last-donation-date">
                Last donation date
              </label>
              <input
                id="last-donation-date"
                className="form-input"
                type="date"
                value={form.last_donation_date ?? ''}
                onChange={(event) => setForm((prev) => ({ ...prev, last_donation_date: event.target.value }))}
              />
            </div>

            <div className="field-row">
              <label className="form-label" htmlFor="next-eligible-date">
                Next eligible date
              </label>
              <input
                id="next-eligible-date"
                className="form-input"
                type="date"
                value={form.next_eligible_date ?? ''}
                onChange={(event) => setForm((prev) => ({ ...prev, next_eligible_date: event.target.value }))}
              />
            </div>

            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save profile'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
