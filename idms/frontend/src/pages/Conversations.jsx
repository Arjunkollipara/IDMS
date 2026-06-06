import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { MessageSquare, Send } from "lucide-react";
import { getBridges, getConversations, getDonors, getPatients, postChat } from "../api";
import { Badge, Card, ErrorState, PageHeader, Spinner, StageBadge } from "../components";
import { formatDateTime, truncateId } from "../utils";

const quickActions = [
  {
    label: "Initial Outreach",
    message: "Hello, I wanted to reach out about an upcoming need for blood donation.",
  },
  {
    label: "Location Check",
    message: "Are you currently in Hyderabad?",
  },
  {
    label: "Thank You",
    message: "Thank you so much for your support!",
  },
];

export default function Conversations() {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [donors, setDonors] = useState([]);
  const [patients, setPatients] = useState([]);
  const [search, setSearch] = useState("");
  const [selectedDonor, setSelectedDonor] = useState(null);
  const [linkedPatientIds, setLinkedPatientIds] = useState([]);
  const [selectedPatientId, setSelectedPatientId] = useState("");
  const [history, setHistory] = useState([]);
  const [conversationStage, setConversationStage] = useState("initial_outreach");
  const [conversationLoading, setConversationLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [sendError, setSendError] = useState("");
  const historyRef = useRef(null);

  const loadBaseData = async () => {
    setError("");
    try {
      const [donorsRes, patientsRes] = await Promise.all([
        getDonors({ category: "Bridge Donor", limit: 100 }),
        getPatients({ limit: 1000 }),
      ]);
      setDonors(Array.isArray(donorsRes.donors) ? donorsRes.donors : []);
      setPatients(Array.isArray(patientsRes.patients) ? patientsRes.patients : []);
    } catch (err) {
      setError(err?.response?.data?.error || err?.response?.data?.detail || err.message || "Failed to load conversations");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      loadBaseData();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const donorId = searchParams.get("donor_id");
    if (!donorId || !donors.length) return;
    const timer = setTimeout(() => {
      const match = donors.find((donor) => donor.user_id === donorId);
      if (match) setSelectedDonor(match);
    }, 0);
    return () => clearTimeout(timer);
  }, [searchParams, donors]);

  useEffect(() => {
    if (!selectedDonor) return;
    let active = true;
    const loadLinkedPatients = async () => {
      setConversationLoading(true);
      try {
        const bridgesRes = await getBridges({ donor_id: selectedDonor.user_id, limit: 100 });
        if (!active) return;
        const patientIds = Array.from(
          new Set((bridgesRes.bridges || []).map((bridge) => bridge.patient_id).filter(Boolean))
        );
        setLinkedPatientIds(patientIds);
        setSelectedPatientId((current) => current && patientIds.includes(current) ? current : patientIds[0] || "");
      } catch (err) {
        if (!active) return;
        setLinkedPatientIds([]);
        setSelectedPatientId("");
        setError(err?.response?.data?.error || err?.response?.data?.detail || err.message || "Failed to load linked patients");
      } finally {
        if (active) setConversationLoading(false);
      }
    };
    const timer = setTimeout(() => {
      loadLinkedPatients();
    }, 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [selectedDonor]);

  const selectedPatient = useMemo(
    () => patients.find((patient) => patient.patient_id === selectedPatientId),
    [patients, selectedPatientId]
  );

  const loadConversation = async (donorId, patientId) => {
    if (!donorId || !patientId) return;
    setConversationLoading(true);
    setSendError("");
    try {
      const data = await getConversations(donorId, patientId);
      setHistory(data.history || []);
      const lastStage = (data.history || []).at(-1)?.conversation_stage || "initial_outreach";
      setConversationStage(lastStage);
    } catch (err) {
      setHistory([]);
      setSendError(err?.response?.data?.error || err?.response?.data?.detail || err.message || "Failed to load conversation");
    } finally {
      setConversationLoading(false);
    }
  };

  useEffect(() => {
    if (selectedDonor && selectedPatientId) {
      const timer = setTimeout(() => {
        loadConversation(selectedDonor.user_id, selectedPatientId);
      }, 0);
      return () => clearTimeout(timer);
    } else {
      const timer = setTimeout(() => {
        setHistory([]);
        setConversationStage("initial_outreach");
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [selectedDonor, selectedPatientId]);

  useEffect(() => {
    if (!historyRef.current) return;
    historyRef.current.scrollTop = historyRef.current.scrollHeight;
  }, [history]);

  const filteredDonors = useMemo(() => {
    const q = search.trim().toLowerCase();
    return donors.filter((donor) => {
      return (
        !q ||
        String(donor.user_id || "").toLowerCase().includes(q) ||
        String(donor.blood_group || "").toLowerCase().includes(q)
      );
    });
  }, [donors, search]);

  const sendMessage = async (text) => {
    if (!selectedDonor || !selectedPatientId || !text.trim()) return;
    setSendError("");
    const userEntry = {
      role: "user",
      message: text.trim(),
      timestamp: new Date().toISOString(),
      conversation_stage: conversationStage,
    };
    setHistory((current) => [...current, userEntry]);
    setMessage("");
    try {
      const result = await postChat(selectedDonor.user_id, selectedPatientId, text.trim());
      setConversationStage(result.conversation_stage || conversationStage);
      setHistory((current) => [
        ...current,
        {
          role: "assistant",
          message: result.response,
          timestamp: new Date().toISOString(),
          conversation_stage: result.conversation_stage || conversationStage,
        },
      ]);
    } catch (err) {
      setSendError(err?.response?.data?.error || err?.response?.data?.detail || err.message || "Failed to send message");
      await loadConversation(selectedDonor.user_id, selectedPatientId);
    }
  };

  if (loading) return <Spinner label="Loading conversations..." />;
  if (error) return <ErrorState error={error} onRetry={loadBaseData} />;

  return (
    <div className="page conversations-page">
      <PageHeader
        title="Conversations"
        subtitle="Manage donor outreach threads and keep the donor-patient relationship human."
      />

      <div className="conversation-grid">
        <Card className="conversation-sidebar">
          <div className="panel-head">
            <h2>Bridge Donors</h2>
            <span>{filteredDonors.length}</span>
          </div>
          <input
            className="input"
            placeholder="Search donors"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="donor-picker">
            {filteredDonors.map((donor) => (
              <button
                key={donor.user_id}
                type="button"
                className={`donor-choice ${selectedDonor?.user_id === donor.user_id ? "active" : ""}`}
                onClick={() => setSelectedDonor(donor)}
              >
                <div>
                  <strong>{truncateId(donor.user_id)}</strong>
                  <p>{donor.blood_group || "—"}</p>
                </div>
                <Badge tone="danger">{donor.donor_category || "Bridge Donor"}</Badge>
              </button>
            ))}
          </div>
        </Card>

        <Card className="conversation-panel">
          {selectedDonor ? (
            <>
              <div className="conversation-head">
                <div>
                  <h2>{truncateId(selectedDonor.user_id)}</h2>
                  <p>{selectedDonor.blood_group || "—"} · {selectedDonor.donor_category || "Bridge Donor"}</p>
                </div>
                <StageBadge stage={conversationStage} />
              </div>

              <label className="input-label">
                Patient
                <select
                  className="input"
                  value={selectedPatientId}
                  onChange={(event) => setSelectedPatientId(event.target.value)}
                >
                  <option value="">Select linked patient</option>
                  {linkedPatientIds.map((patientId) => {
                    const patient = patients.find((item) => item.patient_id === patientId);
                    return (
                      <option key={patientId} value={patientId}>
                        {truncateId(patientId)} {patient?.blood_group ? `· ${patient.blood_group}` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>

              <div className="quick-actions">
                {quickActions.map((item) => (
                  <button key={item.label} type="button" className="chip" onClick={() => sendMessage(item.message)}>
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="chat-history" ref={historyRef}>
                {conversationLoading ? (
                  <Spinner label="Loading chat..." />
                ) : history.length ? (
                  history.map((item, index) => (
                    <div key={`${item.timestamp}-${index}`} className={`bubble-row ${item.role}`}>
                      <div className={`bubble ${item.role === "assistant" ? "bubble-assistant" : "bubble-user"}`}>
                        <div className="bubble-meta">
                          <Badge tone={item.role === "assistant" ? "danger" : "muted"}>
                            {item.role === "assistant" ? "Priya" : "Donor"}
                          </Badge>
                          <small>{formatDateTime(item.timestamp)}</small>
                        </div>
                        <p>{item.message}</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">No messages yet. Select a patient and start the thread.</div>
                )}
              </div>

              <div className="composer">
                <textarea
                  className="input composer-input"
                  rows={3}
                  placeholder="Type a message..."
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                />
                <button type="button" className="btn btn-primary" onClick={() => sendMessage(message)}>
                  <Send size={16} />
                  Send
                </button>
              </div>

              {sendError ? <div className="inline-error">{sendError}</div> : null}
              {selectedPatient ? (
                <div className="patient-mini">
                  <MessageSquare size={16} />
                  <span>
                    {truncateId(selectedPatient.patient_id)} · {selectedPatient.blood_group || "—"} ·{" "}
                    {selectedPatient.expected_next_transfusion_date ? `next ${formatDateTime(selectedPatient.expected_next_transfusion_date)}` : "no next transfusion date"}
                  </span>
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty-state">Select a donor to begin.</div>
          )}
        </Card>
      </div>
    </div>
  );
}
