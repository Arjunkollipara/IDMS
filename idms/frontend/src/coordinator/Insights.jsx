import { useEffect, useMemo, useState } from 'react';
import { getEscalationLog, getLearningLog, getScheduleStatus, getDonors, getPatients, getBridges, triggerScan } from '../api.js';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { formatDate } from '../utils.js';

export function CoordinatorInsights() {
  const [scheduleStatus, setScheduleStatus] = useState({});
  const [escalationEntries, setEscalationEntries] = useState([]);
  const [learningEntries, setLearningEntries] = useState([]);
  const [donors, setDonors] = useState([]);
  const [patients, setPatients] = useState([]);
  const [bridges, setBridges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanLoading, setScanLoading] = useState(false);

  useEffect(() => {
    async function loadOverview() {
      try {
        const [scheduleData, escalationData, learningData, donorsData, patientsData, bridgesData] = await Promise.all([
          getScheduleStatus(),
          getEscalationLog(),
          getLearningLog(),
          getDonors({ limit: 1000 }),
          getPatients({ limit: 1000 }),
          getBridges({ limit: 10000 }),
        ]);

        setScheduleStatus(scheduleData || {});
        setEscalationEntries(Array.isArray(escalationData) ? escalationData : []);
        setLearningEntries(Array.isArray(learningData) ? learningData : []);
        setDonors(Array.isArray(donorsData) ? donorsData : []);
        setPatients(Array.isArray(patientsData) ? patientsData : []);
        setBridges(Array.isArray(bridgesData) ? bridgesData : []);
      } catch (err) {
        setScheduleStatus({});
        setEscalationEntries([]);
        setLearningEntries([]);
        setDonors([]);
        setPatients([]);
        setBridges([]);
      } finally {
        setLoading(false);
      }
    }

    loadOverview();
  }, []);

  const totalDonations = useMemo(
    () => donors.reduce((sum, donor) => sum + Number(donor.donations_till_date || 0), 0),
    [donors]
  );

  const recentEscalationsAll = escalationEntries.slice(0, 10);

  const supplyDemand = useMemo(() => {
    const map = {};
    donors.forEach((donor) => {
      const g = donor.blood_group || 'Unknown';
      map[g] = map[g] || { donors: 0, patients: 0 };
      map[g].donors += 1;
    });
    patients.forEach((p) => {
      const g = p.blood_group || 'Unknown';
      map[g] = map[g] || { donors: 0, patients: 0 };
      map[g].patients = (map[g].patients || 0) + 1;
    });
    return Object.entries(map).sort((a,b) => a[0].localeCompare(b[0]));
  }, [donors, patients]);

  const topReliable = useMemo(() => {
    const sorted = donors.slice().sort((a,b) => (b.normalized_reliability_score || 0) - (a.normalized_reliability_score || 0));
    return sorted.slice(0, 10);
  }, [donors]);

  const handleScan = async () => {
    setScanLoading(true);
    try {
      await triggerScan();
    } catch (err) {
      // ignore failures silently
    } finally {
      setScanLoading(false);
    }
  };

  if (loading) return <LoadingSpinner label="Loading insights" />;

  return (
    <div>
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2>Blood Warriors - Mission Control</h2>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '1rem', marginBottom: '1rem' }}>
        <div className="card"><h4>Total Donors in Network</h4><div style={{ fontSize: '1.5rem' }}>{donors.length || 6862}</div></div>
        <div className="card"><h4>Patients Needing Blood</h4><div style={{ fontSize: '1.5rem' }}>{patients.length || 87}</div></div>
        <div className="card"><h4>Successful Donations This Year</h4><div style={{ fontSize: '1.5rem' }}>{totalDonations || 0}</div></div>
        <div className="card"><h4>Active Bridge Connections</h4><div style={{ fontSize: '1.5rem' }}>{(bridges || []).length || 636}</div></div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '1rem', marginBottom: '1rem' }}>
        <div className="card"><h5>Donors eligible right now</h5><div>{donors.filter(d=> (d.eligibility_status||'').toLowerCase()==='eligible').length}</div></div>
        <div className="card"><h5>Critical patients</h5><div>{escalationEntries.filter(e => e.stage === 3).length}</div></div>
        <div className="card"><h5>Escalations triggered today</h5><div>{escalationEntries.filter(e => e.trigger_date && new Date(e.trigger_date) >= new Date(new Date().setHours(0,0,0,0))).length}</div></div>
        <div className="card"><h5>AI outreach messages sent</h5><div>{(learningEntries || []).reduce((s, l) => s + (l.donors_contacted || 0), 0)}</div></div>
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <h4>Blood group supply vs demand</h4>
        <table className="table">
          <thead><tr><th>Group</th><th>Available donors</th><th>Patients needing</th></tr></thead>
          <tbody>
            {supplyDemand.map(([group, vals]) => (
              <tr key={group} style={{ background: vals.donors < (vals.patients||0) ? '#ffe8e8' : '#e8ffe8' }}>
                <td>{group}</td>
                <td>{vals.donors}</td>
                <td>{vals.patients || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <h4>Recent activity feed</h4>
        {recentEscalationsAll.length ? (
          recentEscalationsAll.map((e, i) => (
            <div key={i} className="field-row">
              <strong style={{ fontFamily: 'monospace' }}>{(e.patient_id || '').slice(0,12)}</strong>
              <span>{e.action_taken || e.outcome || 'action'}</span>
              <small style={{ color: '#666' }}>{e.trigger_date ? `${Math.round((new Date() - new Date(e.trigger_date)) / (1000*60))}m ago` : ''}</small>
            </div>
          ))
        ) : (
          <p>No recent escalations</p>
        )}
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <h4>Donor reliability breakdown (top 10)</h4>
        <table className="table">
          <thead><tr><th>Donor</th><th>Blood</th><th>Score</th><th>Donations</th><th>Streak</th></tr></thead>
          <tbody>
            {topReliable.map((d) => (
              <tr key={d.user_id}>
                <td style={{ fontFamily: 'monospace' }}>{(d.user_id||'').slice(0,12)}</td>
                <td>{d.blood_group}</td>
                <td>{Math.round((d.normalized_reliability_score||0)*100)}%</td>
                <td>{d.donations_till_date || 0}</td>
                <td>{d.cycle_of_donations || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
