import { useEffect, useMemo, useState } from 'react';
import { getPatients, getReservations } from '../api.js';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDate } from '../utils.js';

export function PatientHistory() {
  const [patients, setPatients] = useState(null);
  const [selectedPatientId, setSelectedPatientId] = useState(null);
  const [reservations, setReservations] = useState([]);
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
        setError('Unable to load history data.');
        showToast('Unable to load patient history.', 'error');
      } finally {
        setLoading(false);
      }
    }

    loadPatients();
  }, [showToast]);

  useEffect(() => {
    if (!selectedPatientId) {
      setReservations([]);
      return;
    }

    async function loadHistory() {
      setDetailLoading(true);
      try {
        const result = await getReservations({ patient_id: selectedPatientId });
        setReservations(Array.isArray(result) ? result : []);
      } catch (err) {
        showToast('Unable to load reservation history.', 'error');
      } finally {
        setDetailLoading(false);
      }
    }

    loadHistory();
  }, [selectedPatientId, showToast]);

  const currentPatient = useMemo(() => {
    if (!Array.isArray(patients) || patients.length === 0) return null;
    return patients.find((patient) => patient.patient_id === selectedPatientId) || patients[0];
  }, [patients, selectedPatientId]);

  if (loading) {
    return <LoadingSpinner label="Loading history" />;
  }

  if (error) {
    return <EmptyState title="Unable to load history" message={error} />;
  }

  if (!currentPatient) {
    return <EmptyState title="No patient available" message="Unable to identify a patient profile." />;
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: '1rem' }}>
        <h2>Patient history</h2>
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

      <div className="card" style={{ marginBottom: '1rem' }}>
        <h3>Past transfusions</h3>
        {detailLoading ? (
          <LoadingSpinner label="Loading history details" />
        ) : reservations.length > 0 ? (
          reservations.map((reservation) => (
            <div key={reservation.id ?? reservation.reservation_id} className="field-row">
              <strong>{reservation.status ?? 'Reservation'}</strong>
              <p>Transfusion date: {formatDate(reservation.transfusion_date ?? reservation.date)}</p>
              <p>Donor: {reservation.donor_id ?? reservation.donor_name ?? 'unassigned'}</p>
            </div>
          ))
        ) : (
          <p>No transfusion history found.</p>
        )}
      </div>
    </div>
  );
}
