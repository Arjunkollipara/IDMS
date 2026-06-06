import axios from "axios";

export const BASE = "http://localhost:8000";

export const api = axios.create({
  baseURL: BASE,
  timeout: 30000,
});

function unwrap(response) {
  return response.data;
}

function serializeParams(params = {}) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

export async function getPatients(params = {}) {
  return unwrap(await api.get("/patients", { params: serializeParams(params) }));
}

export async function getDonors(params = {}) {
  return unwrap(await api.get("/donors", { params: serializeParams(params) }));
}

export async function getBridges(params = {}) {
  return unwrap(await api.get("/bridges", { params: serializeParams(params) }));
}

export async function getScheduleStatus() {
  return unwrap(await api.get("/schedule/status"));
}

export async function getRankedDonors(patientId, params = {}) {
  return unwrap(await api.get(`/ranked/${encodeURIComponent(patientId)}`, { params: serializeParams(params) }));
}

export async function getEligibleDonors(patientId, params = {}) {
  return unwrap(await api.get(`/eligible/${encodeURIComponent(patientId)}`, { params: serializeParams(params) }));
}

export async function getEscalationLog(params = {}) {
  return unwrap(await api.get("/escalation-log", { params: serializeParams(params) }));
}

export async function getEscalationPool(patientId) {
  return unwrap(await api.get(`/escalation-pool/${encodeURIComponent(patientId)}`));
}

export async function getConversations(donorId, patientId) {
  return unwrap(
    await api.get("/conversations", {
      params: serializeParams({ donor_id: donorId, patient_id: patientId }),
    })
  );
}

export async function postChat(donorId, patientId, message) {
  return unwrap(await api.post("/chat", { donor_id: donorId, patient_id: patientId, message }));
}

export async function postReserve(donorId, patientId, transfusionDate) {
  return unwrap(
    await api.post("/reserve", {
      donor_id: donorId,
      patient_id: patientId,
      transfusion_date: transfusionDate,
    })
  );
}

export async function postConfirm(reservationId) {
  return unwrap(await api.post("/confirm", { reservation_id: reservationId }));
}

export async function getReservations(params = {}) {
  return unwrap(await api.get("/reservations", { params: serializeParams(params) }));
}

export async function triggerScan() {
  return unwrap(await api.post("/workflow/scan"));
}

export async function triggerPatientWorkflow(patientId) {
  return unwrap(await api.post(`/workflow/trigger/${encodeURIComponent(patientId)}`));
}

export async function getWorkflowStatus(taskId) {
  return unwrap(await api.get(`/workflow/status/${encodeURIComponent(taskId)}`));
}

export async function getLearningLog(params = {}) {
  return unwrap(await api.get("/learning-log", { params: serializeParams(params) }));
}

export async function postOutreach(patientId, stage, languageCode = "en") {
  return unwrap(
    await api.post(`/outreach/${encodeURIComponent(patientId)}/${stage}`, {
      language_code: languageCode,
    })
  );
}

export async function getSonarResults(patientId) {
  return unwrap(await api.get(`/sonar/results/${encodeURIComponent(patientId)}`));
}
