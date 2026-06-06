import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle, MessageSquare, Users } from "lucide-react";
import { getDonors, getEscalationLog, getPatients, getReservations, getScheduleStatus } from "../api";
import { Badge, Card, ErrorState, PageHeader, Spinner, StageBadge, StatCard } from "../components";
import { timeAgo, truncateId } from "../utils";

function sameDay(value) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeDonors, setActiveDonors] = useState(0);
  const [patientsInEscalation, setPatientsInEscalation] = useState(0);
  const [activeReservations, setActiveReservations] = useState(0);
  const [messagesSentToday, setMessagesSentToday] = useState(0);
  const [upcoming, setUpcoming] = useState([]);
  const [recentActivity, setRecentActivity] = useState([]);
  const [patientMap, setPatientMap] = useState({});

  const loadDashboard = async () => {
    setError("");
    try {
      const [donorsRes, scheduleRes, reservationsRes, logsRes, patientsRes] = await Promise.all([
        getDonors({ status: "active", limit: 50 }),
        getScheduleStatus(),
        getReservations({ status: "reserved" }),
        getEscalationLog({ limit: 1000 }),
        getPatients({ limit: 1000 }),
      ]);

      setActiveDonors(donorsRes.count || 0);

      const activePatients = Array.isArray(scheduleRes.active_patients) ? scheduleRes.active_patients : [];
      setPatientsInEscalation(activePatients.filter((item) => item.escalation_stage !== null && item.escalation_stage !== undefined).length);

      setActiveReservations(reservationsRes.count || 0);

      const logs = Array.isArray(logsRes.entries) ? logsRes.entries : [];
      setMessagesSentToday(logs.filter((item) => sameDay(item.trigger_date)).length);
      setRecentActivity(logs.slice(0, 10));

      const patients = Array.isArray(patientsRes.patients) ? patientsRes.patients : [];
      const map = {};
      patients.forEach((patient) => {
        map[patient.patient_id] = patient;
      });
      setPatientMap(map);

      const sorted = [...activePatients]
        .sort((a, b) => (a.days_until_transfusion ?? 9999) - (b.days_until_transfusion ?? 9999))
        .slice(0, 20);
      setUpcoming(sorted);
    } catch (err) {
      setError(err?.response?.data?.error || err?.response?.data?.detail || err.message || "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const initial = setTimeout(() => {
      loadDashboard();
    }, 0);
    const timer = setInterval(loadDashboard, 30000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, []);

  const upcomingRows = useMemo(() => upcoming, [upcoming]);

  if (loading) return <Spinner label="Loading dashboard..." />;
  if (error) return <ErrorState error={error} onRetry={loadDashboard} />;

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        subtitle="Live view of donor coverage, escalation pressure, reservations, and recent activity."
      />

      <div className="stats-grid">
        <StatCard icon={Users} label="Total Active Donors" value={activeDonors} tone="danger" />
        <StatCard
          icon={AlertTriangle}
          label="Patients in Escalation"
          value={patientsInEscalation}
          tone="warning"
        />
        <StatCard icon={CheckCircle} label="Active Reservations" value={activeReservations} tone="success" />
        <StatCard icon={MessageSquare} label="Messages Sent Today" value={messagesSentToday} tone="danger" />
      </div>

      <div className="dashboard-grid">
        <Card className="panel">
          <div className="panel-head">
            <h2>Upcoming Transfusions</h2>
            <span>{upcomingRows.length} rows</span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Blood Group</th>
                  <th>Days Until</th>
                  <th>Stage</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {upcomingRows.map((row) => {
                  const patient = patientMap[row.patient_id] || {};
                  const stage = row.escalation_stage;
                  return (
                    <tr key={row.patient_id}>
                      <td title={row.patient_id}>{truncateId(row.patient_id)}</td>
                      <td>{patient.blood_group || "—"}</td>
                      <td className="strong">{row.days_until_transfusion ?? "—"}</td>
                      <td>
                        <StageBadge stage={stage} daysUntil={row.days_until_transfusion} />
                      </td>
                      <td>
                        <Badge tone={row.color_hint === "red" ? "danger" : row.color_hint === "yellow" ? "warning" : row.color_hint === "green" ? "success" : "muted"}>
                          {row.color_hint || "idle"}
                        </Badge>
                      </td>
                      <td>
                        <button
                          className="btn btn-ghost"
                          type="button"
                          onClick={() => navigate(`/patients?selected=${encodeURIComponent(row.patient_id)}`)}
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="panel">
          <div className="panel-head">
            <h2>Recent Activity</h2>
            <span>Auto-refreshes every 30 seconds</span>
          </div>
          <div className="activity-list">
            {recentActivity.map((entry) => (
              <div className="activity-item" key={`${entry.id}-${entry.trigger_date}`}>
                <div className="activity-badge">
                  <StageBadge stage={entry.stage} />
                </div>
                <div className="activity-copy">
                  <strong>{truncateId(entry.patient_id)}</strong>
                  <p>{entry.action_taken || "—"}</p>
                </div>
                <div className="activity-time">{timeAgo(entry.trigger_date)}</div>
              </div>
            ))}
            {recentActivity.length === 0 ? <div className="empty-state">No recent activity.</div> : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
