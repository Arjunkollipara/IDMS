import axios from 'axios';

export const BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export const api = axios.create({
  baseURL: BASE,
  timeout: 30000,
});

function unwrap(response) {
  return response.data;
}

export function sanitizeId(id) {
  if (id === undefined || id === null) return id;
  return String(id);
}

export function encodeId(id) {
  if (id === undefined || id === null) return id;
  return encodeURIComponent(sanitizeId(id));
}

function serializeParams(params = {}) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
}

export async function getPatients(params = {}) {
  try {
    const data = unwrap(await api.get('/patients', { params: serializeParams(params) }));
    return Array.isArray(data?.patients) ? data.patients : [];
  } catch (err) {
    console.error('getPatients failed:', err);
    return [];
  }
}

export async function getAllPatients() {
  try {
    const data = unwrap(await api.get('/patients/all'));
    return Array.isArray(data?.patients) ? data.patients : [];
  } catch (err) {
    console.error('getAllPatients failed:', err);
    return [];
  }
}

export async function getPatient(patientId) {
  return unwrap(await api.get(`/patients/${encodeId(patientId)}`));
}

export async function getDonors(params = {}) {
  try {
    const data = unwrap(await api.get('/donors', { params: serializeParams(params) }));
    return Array.isArray(data?.donors) ? data.donors : [];
  } catch (err) {
    console.error('getDonors failed:', err);
    return [];
  }
}

export async function getAllDonors() {
  try {
    const data = unwrap(await api.get('/donors/all'));
    return Array.isArray(data?.donors) ? data.donors : [];
  } catch (err) {
    console.error('getAllDonors failed:', err);
    return [];
  }
}

export async function getDonor(donorId) {
  return unwrap(await api.get(`/donors/${encodeId(donorId)}`));
}

export async function getDonorBadges(donorId) {
  return unwrap(await api.get(`/donors/${encodeId(donorId)}/badges`));
}

export async function getDonorStreak(donorId) {
  return unwrap(await api.get(`/donors/${encodeId(donorId)}/streak`));
}

export async function getDonorImpact(donorId) {
  return unwrap(await api.get(`/donors/${encodeId(donorId)}/impact`));
}

export async function getDonorRank(donorId) {
  return unwrap(await api.get(`/donors/${encodeId(donorId)}/rank`));
}

export async function getDonorEligibilityCountdown(donorId) {
  return unwrap(await api.get(`/donors/${encodeId(donorId)}/eligibility-countdown`));
}

export async function getBridges(params = {}) {
  try {
    const data = unwrap(await api.get('/bridges', { params: serializeParams(params) }));
    return Array.isArray(data?.bridges) ? data.bridges : [];
  } catch (err) {
    console.error('getBridges failed:', err);
    return [];
  }
}

export async function getScheduleStatus() {
  try {
    return unwrap(await api.get('/schedule/status'));
  } catch (err) {
    console.error('getScheduleStatus failed:', err);
    return {};
  }
}

export async function getRankedDonors(patientId, params = {}) {
  try {
    const data = unwrap(await api.get(`/ranked/${encodeId(patientId)}`, { params: serializeParams(params) }));
    return Array.isArray(data?.ranked_donors) ? data.ranked_donors : [];
  } catch (err) {
    console.error('getRankedDonors failed:', err);
    return [];
  }
}

export async function getEligibleDonors(patientId, params = {}) {
  try {
    const data = unwrap(await api.get(`/eligible/${encodeId(patientId)}`, { params: serializeParams(params) }));
    // Handle both flat array and nested structure
    const flattened = [];
    if (Array.isArray(data?.donors_by_category)) {
      for (const category of data.donors_by_category) {
        if (Array.isArray(category)) {
          flattened.push(...category);
        }
      }
    }
    return flattened.length > 0 ? flattened : [];
  } catch (err) {
    console.error('getEligibleDonors failed:', err);
    return [];
  }
}

export async function getEscalationLog(params = {}) {
  try {
    const data = unwrap(await api.get('/escalation-log', { params: serializeParams(params) }));
    return Array.isArray(data?.entries) ? data.entries : [];
  } catch (err) {
    console.error('getEscalationLog failed:', err);
    return [];
  }
}

export async function getEscalationPool(patientId) {
  return unwrap(await api.get(`/escalation-pool/${encodeId(patientId)}`));
}

export async function getConversations(donorId, patientId, caller) {
  return unwrap(
    await api.get(`/conversations/${encodeId(donorId)}`, {
      params: serializeParams({ patient_id: patientId, caller }),
    })
  );
}

export async function postChat(donorId, patientId, message, sender) {
  const body = { donor_id: donorId, patient_id: patientId, message };
  if (sender) body.sender = sender;
  return unwrap(await api.post('/chat', body));
}

export async function postSaveMessage(donorId, patientId, message, role) {
  return unwrap(
    await api.post('/conversations/save', {
      donor_id: donorId,
      patient_id: patientId,
      message,
      role,
    })
  );
}

export async function postNotifyDonor(donorId, patientId, message, stage) {
  return unwrap(
    await api.post('/notify-donor', {
      donor_id: donorId,
      patient_id: patientId,
      message,
      stage: typeof stage === 'string' ? Number(stage) : stage,
    })
  );
}

export async function postReserve(donorId, patientId, transfusionDate) {
  return unwrap(
    await api.post('/reserve', {
      donor_id: donorId,
      patient_id: patientId,
      transfusion_date: transfusionDate,
    })
  );
}

export async function postConfirm(reservationId) {
  return unwrap(await api.post('/confirm', { reservation_id: reservationId }));
}

export async function postRelease(reservationId) {
  return unwrap(await api.post('/release', { reservation_id: reservationId }));
}

export async function getReservations(params = {}) {
  try {
    const data = unwrap(await api.get('/reservations', { params: serializeParams(params) }));
    return Array.isArray(data?.reservations) ? data.reservations : [];
  } catch (err) {
    console.error('getReservations failed:', err);
    return [];
  }
}

export async function triggerScan() {
  return unwrap(await api.post('/workflow/scan'));
}

export async function triggerWorkflow(patientId) {
  return unwrap(await api.post(`/workflow/trigger/${encodeId(patientId)}`));
}

export async function getWorkflowStatus(taskId) {
  return unwrap(await api.get(`/workflow/status/${encodeId(taskId)}`));
}

export async function getLearningLog(params = {}) {
  try {
    const data = unwrap(await api.get('/learning-log', { params: serializeParams(params) }));
    return Array.isArray(data?.learning_log) ? data.learning_log : [];
  } catch (err) {
    console.error('getLearningLog failed:', err);
    return [];
  }
}

export async function postOutreach(patientId, stage, languageCode = 'en', draftOnly = false, donorId = null) {
  const numericStage = typeof stage === 'string' ? Number(stage) : stage;
  if (!Number.isInteger(numericStage) || numericStage < 1 || numericStage > 3) {
    throw new Error('Outreach stage must be 1, 2, or 3');
  }

  const body = {
    language_code: languageCode,
    draft_only: draftOnly,
  };
  if (donorId) body.donor_id = donorId;

  return unwrap(
    await api.post(`/outreach/${encodeId(patientId)}/${numericStage}`, body)
  );
}

export async function postAdminAlert(patientId, donorId = null, message = null) {
  try {
    return unwrap(
      await api.post('/admin-alert', {
        patient_id: patientId,
        donor_id: donorId,
        message: message || 'emergency_declared',
      })
    );
  } catch (err) {
    console.error('postAdminAlert failed:', err);
    throw err;
  }
}

export async function declareEmergency(patientId, requiredDate = null, reason = null) {
  return unwrap(
    await api.post(`/emergency/${encodeId(patientId)}`, {
      required_date: requiredDate,
      reason: reason || 'urgent_blood_need',
    })
  );
}

export async function resolveEmergency(patientId) {
  return unwrap(await api.post(`/emergency/resolve/${encodeId(patientId)}`));
}

export async function getActiveEmergencies() {
  try {
    const data = unwrap(await api.get('/emergency/active'));
    return Array.isArray(data?.active_emergencies) ? data.active_emergencies : [];
  } catch (err) {
    console.error('getActiveEmergencies failed:', err);
    return [];
  }
}

export async function getSonarResults(patientId) {
  return unwrap(await api.get(`/sonar/results/${encodeId(patientId)}`));
}

export async function postSonarPing(patientId) {
  return unwrap(await api.post(`/sonar/${encodeId(patientId)}`));
}

export async function updateDonor(donorId, payload) {
  return unwrap(await api.put(`/donors/${encodeId(donorId)}`, payload));
}

export async function getNotificationsLog(donorId = null, params = {}) {
  try {
    const queryParams = { ...serializeParams(params) };
    if (donorId) queryParams.donor_id = donorId;
    const data = unwrap(await api.get('/notifications-log', { params: queryParams }));
    return Array.isArray(data?.notifications) ? data.notifications : [];
  } catch (err) {
    console.error('getNotificationsLog failed:', err);
    return [];
  }
}

export async function getBridgesByPatient(patientId) {
  try {
    const data = unwrap(await api.get('/bridges', { params: serializeParams({ patient_id: patientId }) }));
    return Array.isArray(data?.bridges) ? data.bridges : [];
  } catch (err) {
    console.error('getBridgesByPatient failed:', err);
    return [];
  }
}

export async function postSonarRespond(notificationId, response) {
  return unwrap(
    await api.post('/sonar/respond', {
      notification_id: notificationId,
      response,
    })
  );
}

export async function postDeclineDonor(donorId) {
  try {
    return unwrap(await api.post(`/donors/${encodeId(donorId)}/decline`));
  } catch (err) {
    console.error('postDeclineDonor failed:', err);
    return { success: false };
  }
}

// ── Coordinator Handoff API ────────────────────────────────────────────────

export async function getPendingHandoffs() {
  try {
    const data = unwrap(await api.get('/handoffs/pending'));
    return Array.isArray(data?.pending) ? data.pending : [];
  } catch (err) {
    console.error('getPendingHandoffs failed:', err);
    return [];
  }
}

export async function closeHandoff(donorId, patientId) {
  return unwrap(await api.post('/handoffs/close', { donor_id: donorId, patient_id: patientId }));
}

export async function postCoordinatorMessage(donorId, patientId, message) {
  return unwrap(await api.post('/coordinator/message', { donor_id: donorId, patient_id: patientId, message }));
}
