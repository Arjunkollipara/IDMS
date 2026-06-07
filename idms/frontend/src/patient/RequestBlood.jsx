import { useEffect, useMemo, useState } from 'react';
import { getPatients, postOutreach, triggerWorkflow, declareEmergency } from '../api.js';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDate } from '../utils.js';

export function PatientRequestBlood() {
  const [patients, setPatients] = useState([]);
  const [selectedPatientId, setSelectedPatientId] = useState(null);
  const [quantity, setQuantity] = useState(1);
  const [language, setLanguage] = useState('en');
  const [stage, setStage] = useState(1);
  const [previewMessage, setPreviewMessage] = useState(null);
  const [sending, setSending] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();

  useEffect(() => {
    async function loadPatient() {
      try {
        const result = await getPatients({ status: 'active', limit: 100 });
        setPatients(Array.isArray(result) ? result : []);
        if (Array.isArray(result) && result.length > 0) {
          setSelectedPatientId(result[0].patient_id);
        }
      } catch (err) {
        setPatients([]);
      } finally {
        setLoading(false);
      }
    }

    loadPatient();
  }, []);

  const currentPatient = useMemo(() => {
    if (!Array.isArray(patients) || patients.length === 0) return null;
    return patients.find((patient) => patient.patient_id === selectedPatientId) || patients[0];
  }, [patients, selectedPatientId]);

  async function handleSubmit(event) {
    event.preventDefault();
    const patientId = selectedPatientId || localStorage.getItem('idms_patient_id');
    if (!patientId) {
      showToast('Please select a patient first.', 'warning');
      return;
    }

    setSending(true);
    try {
      if (stage === 3) {
        // Emergency — call POST /emergency/{patient_id}
        await declareEmergency(patientId);
      } else {
        // Standard — trigger the full workflow
        await triggerWorkflow(patientId);
      }
      showToast('Request sent. Blood Warriors is finding donors for you.', 'success');
      setPreviewMessage(`Workflow triggered for patient. Stage: ${stage}`);
    } catch (err) {
      console.error('handleSubmit error:', err);
      showToast('Request failed. Please try again.', 'error');
    } finally {
      setSending(false);
    }
  }

  async function handlePreview() {
    if (!selectedPatientId) {
      showToast('Select a patient first.', 'warning');
      return;
    }

    setPreviewing(true);
    try {
      const result = await postOutreach(selectedPatientId, stage, language, true);
      setPreviewMessage(result?.sample_message || 'No preview message available.');
    } catch (err) {
      showToast('Could not generate preview.', 'error');
    } finally {
      setPreviewing(false);
    }
  }

  if (loading) {
    return <LoadingSpinner label="Loading request blood form" />;
  }

  if (!currentPatient || !patients.length) {
    return <EmptyState title="No patient available" message="No active patient profile could be loaded." />;
  }

  return (
    <div>
      <h2>Request blood</h2>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div className="field-row">
          <label className="form-label" htmlFor="patient-select">
            Patient
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

        <div className="info-grid">
          <div className="info-item">
            <div className="info-label">Blood group</div>
            <div className="info-value">{currentPatient.blood_group || 'unknown'}</div>
          </div>
          <div className="info-item">
            <div className="info-label">Next transfusion</div>
            <div className="info-value">{formatDate(currentPatient.expected_next_transfusion_date)}</div>
          </div>
          <div className="info-item">
            <div className="info-label">Quantity requested</div>
            <div className="info-value">{quantity} unit{quantity === 1 ? '' : 's'}</div>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1rem' }}>
        <form onSubmit={handleSubmit}>
          <div className="field-row">
            <label className="form-label" htmlFor="stage-select">
              Request urgency
            </label>
            <select
              id="stage-select"
              className="form-input"
              value={stage}
              onChange={(event) => setStage(Number(event.target.value))}
            >
              <option value={1}>Stage 1 — initial request</option>
              <option value={2}>Stage 2 — follow-up</option>
              <option value={3}>Stage 3 — urgent</option>
            </select>
            <small>
              {stage === 1 && 'Initial outreach aimed at friendly availability checks.'}
              {stage === 2 && 'Follow-up outreach with urgency and appreciation.'}
              {stage === 3 && 'Final urgent outreach highlighting immediate need and support offer.'}
            </small>
          </div>

          <div className="field-row">
            <label className="form-label" htmlFor="quantity-input">
              Quantity
            </label>
            <input
              id="quantity-input"
              className="form-input"
              type="number"
              min={1}
              value={quantity}
              onChange={(event) => setQuantity(Number(event.target.value || 1))}
            />
          </div>

          <div className="field-row">
            <label className="form-label" htmlFor="language-select">
              Language
            </label>
            <select
              id="language-select"
              className="form-input"
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
            >
              <option value="en">English</option>
              <option value="hi">Hindi</option>
              <option value="es">Spanish</option>
            </select>
          </div>

          <div className="field-row">
            <button type="button" className="btn btn-ghost" onClick={handlePreview} disabled={previewing}>
              {previewing ? 'Generating preview…' : 'Preview outreach message'}
            </button>
            <button type="submit" className="btn btn-primary" disabled={sending}>
              {sending ? 'Sending request…' : 'Send request'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3>Preview</h3>
        <p>{previewMessage || 'Preview text will appear here after generating a draft.'}</p>
      </div>
    </div>
  );
}
