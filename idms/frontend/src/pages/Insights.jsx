import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getDonors, getEscalationLog, getLearningLog } from "../api";
import { Card, ErrorState, PageHeader, Spinner } from "../components";
import { formatDate, truncateId } from "../utils";

const pieColors = {
  active: "#27AE60",
  inactive: "#E74C3C",
};

export default function Insights() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [donors, setDonors] = useState([]);
  const [logs, setLogs] = useState([]);
  const [learning, setLearning] = useState([]);

  const loadInsights = async () => {
    setError("");
    try {
      const [donorsRes, logsRes, learningRes] = await Promise.all([
        getDonors({ limit: 7000 }),
        getEscalationLog({ limit: 200 }),
        getLearningLog({ limit: 20 }),
      ]);
      setDonors(Array.isArray(donorsRes.donors) ? donorsRes.donors : []);
      setLogs(Array.isArray(logsRes.entries) ? logsRes.entries : []);
      setLearning(Array.isArray(learningRes.learning_log) ? learningRes.learning_log : []);
    } catch (err) {
      setError(err?.response?.data?.error || err?.response?.data?.detail || err.message || "Failed to load insights");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      loadInsights();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const donationByBloodGroup = useMemo(() => {
    const map = new Map();
    donors.forEach((donor) => {
      const key = donor.blood_group || "Unknown";
      const current = map.get(key) || 0;
      map.set(key, current + Number(donor.donations_till_date || 0));
    });
    return Array.from(map.entries()).map(([blood_group, total_donations]) => ({
      blood_group,
      total_donations,
    }));
  }, [donors]);

  const activityData = useMemo(() => {
    const active = donors.filter((donor) => String(donor.user_donation_active_status || "").toLowerCase() === "active").length;
    return [
      { name: "Active", value: active, color: pieColors.active },
      { name: "Inactive", value: Math.max(0, donors.length - active), color: pieColors.inactive },
    ];
  }, [donors]);

  const stageData = useMemo(() => {
    const byDate = new Map();
    logs.forEach((entry) => {
      const date = entry.trigger_date ? new Date(entry.trigger_date).toISOString().slice(0, 10) : "unknown";
      if (!byDate.has(date)) {
        byDate.set(date, { date, stage_1: 0, stage_2: 0, stage_3: 0 });
      }
      const bucket = byDate.get(date);
      if (entry.stage === 1) bucket.stage_1 += 1;
      if (entry.stage === 2) bucket.stage_2 += 1;
      if (entry.stage === 3) bucket.stage_3 += 1;
    });
    return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [logs]);

  if (loading) return <Spinner label="Loading insights..." />;
  if (error) return <ErrorState error={error} onRetry={loadInsights} />;

  return (
    <div className="page">
      <PageHeader title="Insights" subtitle="Live charts and learning history drawn directly from production data." />

      <div className="insight-grid">
        <Card className="panel chart-panel">
          <div className="panel-head">
            <h2>Donations by Blood Group</h2>
            <span>Aggregation from live donor records</span>
          </div>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={donationByBloodGroup}>
                <CartesianGrid stroke="#333" strokeDasharray="3 3" />
                <XAxis dataKey="blood_group" stroke="#fff" />
                <YAxis stroke="#fff" />
                <Tooltip
                  contentStyle={{ background: "#16213E", border: "1px solid #333", color: "#fff" }}
                  labelStyle={{ color: "#fff" }}
                />
                <Bar dataKey="total_donations" fill="#C0392B" radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="panel chart-panel">
          <div className="panel-head">
            <h2>Escalation Stages Over Time</h2>
            <span>Triggered log counts grouped by day</span>
          </div>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={stageData}>
                <CartesianGrid stroke="#333" strokeDasharray="3 3" />
                <XAxis dataKey="date" stroke="#fff" />
                <YAxis stroke="#fff" />
                <Tooltip
                  contentStyle={{ background: "#16213E", border: "1px solid #333", color: "#fff" }}
                  labelStyle={{ color: "#fff" }}
                />
                <Legend />
                <Line type="monotone" dataKey="stage_1" stroke="#27AE60" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="stage_2" stroke="#F39C12" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="stage_3" stroke="#C0392B" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="panel chart-panel">
          <div className="panel-head">
            <h2>Donor Activity Status</h2>
            <span>Active vs inactive donor counts</span>
          </div>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Tooltip
                  contentStyle={{ background: "#16213E", border: "1px solid #333", color: "#fff" }}
                  labelStyle={{ color: "#fff" }}
                />
                <Legend />
                <Pie data={activityData} dataKey="value" nameKey="name" outerRadius={100} innerRadius={52}>
                  {activityData.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card className="panel chart-panel wide-panel">
          <div className="panel-head">
            <h2>Learning Log</h2>
            <span>Cycle summaries from task-based learning</span>
          </div>
          {learning.length ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Patient</th>
                    <th>Stages</th>
                    <th>Contacted</th>
                    <th>Responded</th>
                    <th>Donated</th>
                    <th>Pattern Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {learning.map((item) => (
                    <tr key={item.id}>
                      <td>{formatDate(item.cycle_date)}</td>
                      <td title={item.patient_id}>{truncateId(item.patient_id)}</td>
                      <td>{item.stages_needed ?? "—"}</td>
                      <td>{item.donors_contacted ?? "—"}</td>
                      <td>{item.donors_responded ?? "—"}</td>
                      <td>{item.donors_donated ?? "—"}</td>
                      <td>{item.pattern_notes || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">No learning cycles completed yet.</div>
          )}
        </Card>
      </div>
    </div>
  );
}
