import { useEffect, useMemo, useState, useCallback } from 'react';
import { getDonor, getReservations, getDonors, getBridges } from '../api.js';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { formatDate } from '../utils.js';

export function DonorDonations({ donorId, selectedDonorBloodGroup }) {
  const [donorProfile, setDonorProfile] = useState(null);
  const [reservations, setReservations] = useState([]);
  const [bridges, setBridges] = useState([]);
  const [donors, setDonors] = useState([]);
  const [selectedDonorId, setSelectedDonorId] = useState('');
  const [loading, setLoading] = useState(true);

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
    if (!activeDonorId) {
      setLoading(false);
      return;
    }

    async function loadDetails() {
      setLoading(true);
      try {
        const results = await Promise.allSettled([
          getDonor(activeDonorId),
          getReservations(activeDonorId),
          getBridges({ donor_id: activeDonorId }),
        ]);

        const donorResult = results[0];
        setDonorProfile(donorResult.status === 'fulfilled' ? donorResult.value?.donor || donorResult.value || null : null);

        const reservationResult = results[1];
        setReservations(reservationResult.status === 'fulfilled' ? reservationResult.value?.reservations || reservationResult.value || [] : []);

        const bridgesResult = results[2];
        setBridges(bridgesResult.status === 'fulfilled' ? bridgesResult.value || [] : []);
      } catch (err) {
        console.error('Unexpected error loading donation details:', err);
      } finally {
        setLoading(false);
      }
    }

    loadDetails();
  }, [activeDonorId]);

  // Calculate Badge System from Bridges data
  const badgesList = useMemo(() => {
    const totalDonations = bridges.reduce((sum, b) => sum + (b.donations_till_date || 0), 0);
    const hasChain1 = bridges.some((b) => Number(b.chain_position) === 1);

    return [
      {
        id: 'first_donation',
        name: 'First Donation',
        earned: totalDonations >= 1,
        description: 'Donated 1 time',
        req: 1,
        type: 'star',
      },
      {
        id: 'regular_donor',
        name: 'Regular Donor',
        earned: totalDonations >= 5,
        description: 'Donated 5 times',
        req: 5,
        type: 'heart',
      },
      {
        id: 'dedicated',
        name: 'Dedicated',
        earned: totalDonations >= 10,
        description: 'Donated 10 times',
        req: 10,
        type: 'shield',
      },
      {
        id: 'life_saver',
        name: 'Life Saver',
        earned: totalDonations >= 20,
        description: 'Donated 20 times',
        req: 20,
        type: 'heart',
      },
      {
        id: 'blood_warrior',
        name: 'Blood Warrior',
        earned: totalDonations >= 50,
        description: 'Donated 50 times',
        req: 50,
        type: 'star',
      },
      {
        id: 'chain_guardian',
        name: 'Chain Guardian',
        earned: hasChain1,
        description: 'Has bridge with chain pos #1',
        req: 1,
        type: 'shield',
      },
    ];
  }, [bridges]);

  // Calculate Streak count
  const streakCount = useMemo(() => {
    const months = bridges
      .map((b) => b.last_bridge_donation_date)
      .filter(Boolean)
      .map((d) => {
        const date = new Date(d);
        return {
          year: date.getFullYear(),
          month: date.getMonth(),
        };
      });

    if (months.length === 0) return 0;

    const monthKeys = [...new Set(months.map((m) => m.year * 12 + m.month))].sort((a, b) => b - a);
    const now = new Date();
    const currentMonthKey = now.getFullYear() * 12 + now.getMonth();

    if (monthKeys[0] !== currentMonthKey && monthKeys[0] !== currentMonthKey - 1) {
      return 0;
    }

    let streak = 1;
    for (let i = 0; i < monthKeys.length - 1; i++) {
      if (monthKeys[i] - monthKeys[i + 1] === 1) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }, [bridges]);

  // Calculate Impact Summary
  const impactSummary = useMemo(() => {
    const totalDonations = bridges.reduce((sum, b) => sum + (b.donations_till_date || 0), 0);
    const uniquePatients = new Set(bridges.map((b) => b.patient_id).filter(Boolean)).size;

    const countBadges = [
      { name: 'First Donation', req: 1 },
      { name: 'Regular Donor', req: 5 },
      { name: 'Dedicated', req: 10 },
      { name: 'Life Saver', req: 20 },
      { name: 'Blood Warrior', req: 50 },
    ];
    const nextBadge = countBadges.find((b) => totalDonations < b.req) || { name: 'Blood Warrior Master', req: 100 };
    const prevReq = countBadges[countBadges.findIndex((b) => b.name === nextBadge.name) - 1]?.req || 0;
    const progressPercent = Math.min(100, Math.round(((totalDonations - prevReq) / (nextBadge.req - prevReq)) * 100)) || 0;

    return {
      totalDonations,
      uniquePatients,
      nextBadge,
      progressPercent,
    };
  }, [bridges]);

  const renderBadgeIcon = (type) => {
    if (type === 'star') {
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '8px' }}>
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      );
    }
    if (type === 'heart') {
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '8px' }}>
          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
        </svg>
      );
    }
    return (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '8px' }}>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    );
  };

  if (loading) {
    return <LoadingSpinner label="Loading donations" />;
  }

  return (
    <div>
      <h2>Donations</h2>
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

      {/* Badges System */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h3>YOUR BADGES</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          {badgesList.map((badge) => (
            <div
              key={badge.id}
              style={{
                background: badge.earned ? 'var(--green-dim)' : 'var(--surface-2)',
                border: badge.earned ? '1px solid var(--green)' : '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '14px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                color: badge.earned ? '#27ae60' : 'var(--text-label)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center' }}>
                {renderBadgeIcon(badge.type)}
                <div>
                  <strong style={{ display: 'block', color: badge.earned ? '#1b5e20' : 'var(--text-body)' }}>{badge.name}</strong>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-label)' }}>{badge.description}</span>
                </div>
              </div>
              <div>
                {badge.earned ? (
                  <span style={{ fontWeight: 'bold', fontSize: '1.2rem' }}>✓</span>
                ) : (
                  <span style={{ opacity: 0.5 }}>🔒</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Donation Streak */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h3>DONATION STREAK</h3>
        {streakCount > 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '2rem' }}>🔥</span>
            <strong style={{ fontSize: '1.2rem', color: 'var(--yellow)' }}>{streakCount} month streak</strong>
          </div>
        ) : (
          <p style={{ margin: 0, color: 'var(--text-label)' }}>Start your streak by donating this month</p>
        )}
      </div>

      {/* Impact Summary Card */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h3>IMPACT SUMMARY</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
          <div className="card-sm" style={{ padding: '16px' }}>
            <span style={{ fontSize: '2.5rem', fontWeight: 'bold', color: 'var(--green)', display: 'block' }}>
              {impactSummary.uniquePatients}
            </span>
            <strong>Patients Helped</strong>
          </div>
          <div className="card-sm" style={{ padding: '16px' }}>
            <span style={{ fontSize: '2.5rem', fontWeight: 'bold', color: 'var(--green)', display: 'block' }}>
              {impactSummary.totalDonations}
            </span>
            <strong>Total Donations</strong>
          </div>
        </div>
        
        <div style={{ background: 'var(--bg-light)', padding: '12px 16px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', marginBottom: '16px' }}>
          <p style={{ margin: 0, fontStyle: 'italic', color: 'var(--text-body)', textAlign: 'center' }}>
            "Each donation gives a Thalassemia patient 3 more weeks of life"
          </p>
        </div>

        {/* Progress to next badge */}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', marginBottom: '8px' }}>
            <span>Next Badge: <strong>{impactSummary.nextBadge.name}</strong></span>
            <span>{impactSummary.totalDonations} / {impactSummary.nextBadge.req} donations</span>
          </div>
          <div style={{ background: '#eee', height: '12px', borderRadius: '6px', overflow: 'hidden' }}>
            <div style={{ width: `${impactSummary.progressPercent}%`, background: 'var(--green)', height: '100%', borderRadius: 'inherit', transition: 'width 0.3s ease' }} />
          </div>
        </div>
      </div>

      {/* Donation History (Bridges) */}
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h3>DONATION HISTORY</h3>
        {bridges.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {bridges.map((bridge, index) => (
              <div key={index} className="card-sm" style={{ textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong>Patient: <code style={{ fontFamily: 'monospace' }}>{bridge.patient_id ? bridge.patient_id.slice(0, 14) : '—'}...</code></strong>
                  <p style={{ margin: '4px 0 0', fontSize: '0.9rem' }}>Blood Group: {bridge.bridge_blood_group || 'unknown'}</p>
                  <p style={{ margin: '2px 0 0', fontSize: '0.8rem', color: 'var(--text-label)' }}>
                    Last Donation: {formatDate(bridge.last_bridge_donation_date)}
                  </p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span className="badge badge-success" style={{ fontWeight: '600' }}>
                    {bridge.donations_till_date || 0} donations
                  </span>
                  <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'var(--text-label)' }}>
                    Chain Position: #{bridge.chain_position || '—'}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No donation history" message="No bridge donor records found." />
        )}
      </div>

      {/* Reservations */}
      <div className="card">
        <h3>Reservations and activity</h3>
        {Array.isArray(reservations) && reservations.length > 0 ? (
          reservations.map((reservation) => (
            <div key={reservation.id ?? reservation.reservation_id} className="card" style={{ marginBottom: '0.75rem' }}>
              <strong>{reservation.status ?? 'Reservation'}</strong>
              <p>Date: {formatDate(reservation.transfusion_date ?? reservation.date)}</p>
              <p>Patient: {reservation.patient_id ?? reservation.patient_name ?? 'unknown'}</p>
              <p>Confirmed: {reservation.confirmed ? 'Yes' : 'No'}</p>
            </div>
          ))
        ) : (
          <EmptyState title="No active reservations" message="No reservation history is available for this donor." />
        )}
      </div>
    </div>
  );
}
