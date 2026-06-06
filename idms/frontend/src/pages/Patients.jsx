import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, RotateCw } from "lucide-react";
import {
  getEscalationPool,
  getPatients,
  getRankedDonors,
  getScheduleStatus,
  getWorkflowStatus,
  postReserve,
  triggerPatientWorkflow,
} from "../api";
import { Badge, Card, Drawer, ErrorState, Modal, PageHeader, Spinner, StageBadge } from "../components";
import { formatDate, formatDateTime, truncateId } from "../utils";

function daysUntil(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const diff = date.setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0);
  return Math.round(diff / 86400000);
}

function Field({ label, value }) {
  return (
    <div className="field-row">
      <span>{label}</span>
      <strong>{value ?? "—"}</strong>
    </div>
  );
}

export default function Patients() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [patients, setPatients] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [selected, setSelected] = useState(null);
  const [pool, setPool] = useState(null);
  const [poolLoading, setPoolLoading] = useState(false);
  const [ranked, setRanked] = useState([]);
  const [rankedLoading, setRankedLoading] = useState(false);
  const [reserveCandidate, setReserveCandidate] = useState(null);
  const [reserveDate, setReserveDate] = useState("");
  const [reserveMessage, setReserveMessage] = useState("");
  const [workflowTaskId, setWorkflowTaskId] = useState("");
  const [workflowStatus, setWorkflowStatus] = useState("");
  const [workflowResult, setWorkflowResult] = useState(null);
  const [workflowError, setWorkflowError] = useState("");
  const pollRef = useRef(null);

  const stageForDays = (value) => {
    if (value === null || value === undefined) return 0;
    if (value <= 3) return 3;
    if (value <= 5) return 2;
    if (value <= 7) return 1;
    return 0;
  };

  const loadPatients = async () => {
    setError("");
    try {
      const [patientsRes, scheduleRes] = await Promise.all([getPatients({ limit: 1000 }), getScheduleStatus()]);
      setPatients(Array.isArray(patientsRes.patients) ? patientsRes.patients : []);
      setSchedule(Array.isArray(scheduleRes.active_patients) ? scheduleRes.active_patients : []);
    } catch (err) {
      setError(err?.response?.data?.error || err?.response?.data?.detail || err.message || "Failed to load patients");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      loadPatients();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!patients.length) return;
    const selectedId = searchParams.get("selected");
    if (selectedId) {
      const timeout = setTimeout(() => {
        const found = patients.find((patient) => patient.patient_id === selectedId);
        if (found) setSelected(found);
      }, 0);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [patients, searchParams]);

  useEffect(() => {
    if (!selected) return;
    const timer = setTimeout(() => {
      setReserveMessage("");
      setReserveDate((selected.expected_next_transfusion_date || "").slice(0, 10));
      setRanked([]);
      setPool(null);
    }, 0);

    let active = true;
    const loadPool = async () => {
      setPoolLoading(true);
      try {
        const data = await getEscalationPool(selected.patient_id);
        if (!active) return;
        setPool(data);
      } catch (err) {
        if (!active) return;
        setPool({ error: err?.response?.data?.error || err.message || "Failed to load escalation pool" });
      } finally {
        if (active) setPoolLoading(false);
      }
    };

    const loadTimer = setTimeout(() => {
      loadPool();
    }, 0);
    return () => {
      active = false;
      clearTimeout(timer);
      clearTimeout(loadTimer);
    };
  }, [selected]);

  useEffect(() => {
    if (!workflowTaskId) return undefined;

    const poll = async () => {
      try {
        const status = await getWorkflowStatus(workflowTaskId);
        setWorkflowStatus(status.status);
        if (status.status === "SUCCESS" || status.status === "FAILURE") {
          setWorkflowResult(status.result || null);
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      } catch (err) {
        setWorkflowError(err?.response?.data?.error || err.message || "Failed to poll workflow");
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }
    };

    poll();
    pollRef.current = setInterval(poll, 3000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [workflowTaskId]);

  const rows = useMemo(() => {
    const map = new Map(schedule.map((item) => [item.patient_id, item]));
    return patients.map((patient) => ({
      ...patient,
      schedule: map.get(patient.patient_id) || {},
      days_until_transfusion:
        map.get(patient.patient_id)?.days_until_transfusion ?? daysUntil(patient.expected_next_transfusion_date),
      stage: map.get(patient.patient_id)?.escalation_stage ?? null,
    }));
  }, [patients, schedule]);

  const selectedSchedule = useMemo(() => {
    if (!selected) return null;
    return schedule.find((item) => item.patient_id === selected.patient_id) || null;
  }, [schedule, selected]);

  const activeDays = selectedSchedule?.days_until_transfusion ?? daysUntil(selected?.expected_next_transfusion_date);

  const loadRanked = async () => {
    if (!selected) return;
    setRankedLoading(true);
    try {
      const data = await getRankedDonors(selected.patient_id);
      setRanked(Array.isArray(data.ranked_donors) ? data.ranked_donors : data.top_5 || []);
    } catch (err) {
      setError(err?.response?.data?.error || err?.response?.data?.detail || err.message || "Failed to load ranked donors");
    } finally {
      setRankedLoading(false);
    }
  };

  const startWorkflow = async () => {
    if (!selected) return;
    setWorkflowError("");
    setWorkflowResult(null);
    try {
      const data = await triggerPatientWorkflow(selected.patient_id);
      setWorkflowTaskId(data.task_id);
      setWorkflowStatus(data.status);
    } catch (err) {
      setWorkflowError(err?.response?.data?.error || err?.response?.data?.detail || err.message || "Failed to trigger workflow");
    }
  };

  const reserveDonor = async () => {
    if (!reserveCandidate) return;
    setReserveMessage("");
    try {
      const data = await postReserve(reserveCandidate.donor_id, selected.patient_id, reserveDate);
      setReserveMessage(`Reservation created: ${data?.reservation?.id ?? "success"}`);
      setReserveCandidate(null);
      await loadPatients();
    } catch (err) {
      setReserveMessage(err?.response?.data?.error || err?.response?.data?.detail || err.message || "Failed to reserve donor");
    }
  };

  if (loading) return <Spinner label="Loading patients..." />;
  if (error) return <ErrorState error={error} onRetry={loadPatients} />;

  return (
    <div className="page">
      <PageHeader title="Patients" subtitle="Track transfusion urgency, donor ranking, escalation pools, and reservations." />

      <Card className="panel">
        <div className="panel-head">
          <h2>All Patients</h2>
          <span>{rows.length} records</span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Patient ID</th>
                <th>Blood Group</th>
                <th>Frequency</th>
                <th>Next Transfusion</th>
                <th>Days Until</th>
                <th>Stage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((patient) => (
                <tr
                  key={patient.patient_id}
                  className={selected?.patient_id === patient.patient_id ? "selected-row" : ""}
                  onClick={() => {
                    setSelected(patient);
                    setSearchParams({ selected: patient.patient_id });
                  }}
                >
                  <td title={patient.patient_id}>{truncateId(patient.patient_id)}</td>
                  <td>{patient.blood_group || "—"}</td>
                  <td>{patient.frequency_in_days ?? "—"} days</td>
                  <td>{formatDate(patient.expected_next_transfusion_date)}</td>
                  <td className={`strong days-${patient.stage || stageForDays(patient.days_until_transfusion)}`}>
                    {patient.days_until_transfusion ?? "—"}
                  </td>
                  <td>
                    <StageBadge stage={patient.stage} daysUntil={patient.days_until_transfusion} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title="Patient Detail" width={420}>
        {selected ? (
          <div className="drawer-stack">
            <div className="mono-box" title={selected.patient_id}>
              {selected.patient_id}
            </div>

            <div className="countdown-card">
              <span>Days Until Transfusion</span>
              <strong className={`countdown days-${selectedSchedule?.escalation_stage || stageForDays(activeDays)}`}>
                {activeDays ?? "—"}
              </strong>
              <StageBadge stage={selectedSchedule?.escalation_stage} daysUntil={activeDays} />
            </div>

            <div className="detail-grid">
              <Field label="Blood Group" value={selected.blood_group} />
              <Field label="Gender" value={selected.gender} />
              <Field label="Quantity Required" value={selected.quantity_required} />
              <Field label="Frequency" value={selected.frequency_in_days ? `${selected.frequency_in_days} days` : "—"} />
              <Field label="Last Transfusion" value={formatDateTime(selected.last_transfusion_date)} />
              <Field label="Expected Next" value={formatDateTime(selected.expected_next_transfusion_date)} />
              <Field label="Status" value={selected.status} />
              <Field label="Registered" value={formatDateTime(selected.registration_date)} />
            </div>

            <div className="section-block">
              <div className="section-head">
                <h3>Ranked Donors</h3>
                <button className="btn btn-ghost" type="button" onClick={loadRanked} disabled={rankedLoading}>
                  <RotateCw size={16} />
                  Load Ranked Donors
                </button>
              </div>
              {rankedLoading ? (
                <Spinner label="Loading ranked donors..." />
              ) : ranked.length ? (
                <div className="ranked-list">
                  {ranked.slice(0, 10).map((donor) => (
                    <div className="ranked-item" key={donor.donor_id}>
                      <div>
                        <strong>{truncateId(donor.donor_id)}</strong>
                        <p>{donor.donor_category || "—"}</p>
                        <small>
                          rel {donor.relationship_score?.toFixed?.(1) ?? donor.relationship_score} · recency{" "}
                          {donor.recency_score?.toFixed?.(1) ?? donor.recency_score} · proximity{" "}
                          {donor.proximity_score?.toFixed?.(1) ?? donor.proximity_score}
                        </small>
                      </div>
                      <div className="ranked-actions">
                        <strong>{Number(donor.total_score || 0).toFixed(2)}</strong>
                        <button
                          type="button"
                          className="btn btn-primary"
                          onClick={() => {
                            setReserveCandidate(donor);
                            setReserveDate((selected.expected_next_transfusion_date || "").slice(0, 10));
                          }}
                        >
                          Reserve
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">Load ranked donors to see the top 10 matches.</div>
              )}
            </div>

            <div className="section-block">
              <div className="section-head">
                <h3>Escalation Pool</h3>
                {poolLoading ? <Loader2 className="spin-icon" size={16} /> : null}
              </div>
              {pool && pool.error ? (
                <ErrorState error={pool.error} />
              ) : pool ? (
                <div className="pool-grid">
                  <Badge tone="success">Stage 1: {pool.stage_1_bridge_donors?.length || 0}</Badge>
                  <Badge tone="warning">Stage 2: {pool.stage_2_emergency_donors?.length || 0}</Badge>
                  <Badge tone="danger">Stage 3: {pool.stage_3_all_active_donors?.length || 0}</Badge>
                </div>
              ) : (
                <div className="empty-state">No escalation pool data.</div>
              )}
            </div>

            <div className="section-block">
              <div className="section-head">
                <h3>Manual Trigger</h3>
                <button type="button" className="btn btn-primary" onClick={startWorkflow}>
                  Trigger Workflow
                </button>
              </div>
              {workflowTaskId ? (
                <div className="workflow-box">
                  <Field label="Task ID" value={workflowTaskId} />
                  <Field label="Status" value={workflowStatus} />
                  {workflowResult ? (
                    <pre className="json-box">{JSON.stringify(workflowResult, null, 2)}</pre>
                  ) : null}
                </div>
              ) : null}
              {workflowError ? <div className="inline-error">{workflowError}</div> : null}
            </div>

            {reserveMessage ? <div className="inline-success">{reserveMessage}</div> : null}
          </div>
        ) : null}
      </Drawer>

      <Modal
        title="Reserve Donor"
        open={Boolean(reserveCandidate)}
        onClose={() => setReserveCandidate(null)}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setReserveCandidate(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={reserveDonor}>
              Confirm Reservation
            </button>
          </>
        }
      >
        {reserveCandidate ? (
          <div className="modal-form">
            <div className="field-row">
              <span>Donor</span>
              <strong>{truncateId(reserveCandidate.donor_id)}</strong>
            </div>
            <div className="field-row">
              <span>Patient</span>
              <strong>{truncateId(selected?.patient_id)}</strong>
            </div>
            <label className="input-label">
              Transfusion Date
              <input type="date" className="input" value={reserveDate} onChange={(e) => setReserveDate(e.target.value)} />
            </label>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
