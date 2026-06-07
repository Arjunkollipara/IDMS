import { useEffect, useMemo, useState } from 'react';
import { getEscalationLog, getPatients, getReservations, getSonarResults } from '../api.js';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDate } from '../utils.js';

export function PatientNotifications() {
  const [patients, setPatients] = useState(null);
  const [selectedPatientId, setSelectedPatientId] = useState(null);
  const [reservations, setReservations] = useState([]);
  const [escalationEntries, setEscalationEntries] = useState([]);
  const [sonarResults, setSonarResults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(null);
  const { showToast } = useToast();

  useEffect(() => {
    async function loadPatients() {
      try {
        const result = await getPatients({ limit: 100 });
        setPatients(Array.isArray(result) ? result : []);
        if (Array.isArray(result) && result.length > 0) {
          setSelectedPatientId(result[0].patient_id);
        }
      } catch (err) {
        setError('Unable to load notifications.');
        showToast('Unable to load notifications.', 'error');
      } finally {
        setLoading(false);
      }
    }

    loadPatients();
  }, [showToast]);

  useEffect(() => {
    if (!selectedPatientId) {
      setReservations([]);
      setEscalationEntries([]);
      setSonarResults(null);
      return;
    }

    async function loadNotifications() {
      setDetailLoading(true);
      try {
        const [reservationsResult, escalationResult, sonarResult] = await Promise.all([
          getReservations({ patient_id: selectedPatientId }),
          getEscalationLog({ patient_id: selectedPatientId }),
          getSonarResults(selectedPatientId),
        ]);

        setReservations(Array.isArray(reservationsResult) ? reservationsResult : []);
        setEscalationEntries(Array.isArray(escalationResult) ? escalationResult : []);
        setSonarResults(sonarResult);
      } catch (err) {
        showToast('Unable to load notification details.', 'error');
      } finally {
        setDetailLoading(false);
      }
    }

    loadNotifications();
  }, [selectedPatientId, showToast]);

  const currentPatient = useMemo(() => {
    if (!Array.isArray(patients) || patients.length === 0) return null;
    return patients.find((patient) => patient.patient_id === selectedPatientId) || patients[0];
  }, [patients, selectedPatientId]);

  if (loading) {
    return <LoadingSpinner label="Loading notifications" />;
  }

  if (error) {
    return <EmptyState title="Unable to load notifications" message={error} />;
  }

  if (!currentPatient) {
    return <EmptyState title="No patient available" message="Unable to identify a patient profile." />;
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2>Notifications for {currentPatient.patient_id}</h2>
        <div className="field-row">
          <label className="form-label" htmlFor="patient-select">
            Select patient
          </label>
          <select
            id="patient-select"
            className="form-input"
            value={selectedPatientId || ''}
            onChange={(event) => setSelectedPatientId(event.target.value)}
          >
            {Array.isArray(patients)
              ? patients.map((patient, index) => (
                  <option key={patient.patient_id} value={patient.patient_id}>
                    Patient {index + 1} — {patient.blood_group || 'Unknown'}
                  </option>
                ))
              : null}
          </select>
        </div>
      </div>

      {detailLoading ? (
        <LoadingSpinner label="Loading notification details" />
      ) : (
        <>
          <div className="card" style={{ marginBottom: '1rem' }}>
            <h3>Reservation notifications</h3>
            {reservations.length > 0 ? (
              reservations.map((reservation) => (
                <div key={reservation.id ?? reservation.reservation_id} className="field-row">
                  <strong>{reservation.status ?? 'Reservation'}</strong>
                  <p>Date: {formatDate(reservation.transfusion_date ?? reservation.date)}</p>
                  <p>Donor: {reservation.donor_id ?? 'unassigned'}</p>
                </div>
              ))
            ) : (
              <p>No reservation notifications available.</p>
            )}
          </div>

          <div className="card" style={{ marginBottom: '1rem' }}>
            <h3>Escalation log</h3>
            {escalationEntries.length > 0 ? (
              escalationEntries.map((item, index) => (
                <div key={item.id ?? index} className="field-row">
                  <strong>Stage {item.stage ?? '—'}</strong>
                  <p>{item.action_taken ?? item.outcome ?? 'No details provided.'}</p>
                  <p>{formatDate(item.trigger_date)}</p>
                </div>
              ))
            ) : (
              <p>No escalation entries for this patient.</p>
            )}
          </div>

          <div className="card">
            <h3>Sonar summary</h3>
            {sonarResults ? (
              <div>
                <p>Pings sent: {sonarResults.pings_sent ?? '—'}</p>
                <p>Patient ID: {sonarResults.patient_id ?? '—'}</p>
              </div>
            ) : (
              <p>No sonar summary available.</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
