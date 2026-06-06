import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getConversations, getDonors } from "../api";
import { Badge, Card, Drawer, ErrorState, PageHeader, Spinner } from "../components";
import {
  formatDate,
  formatDateTime,
  getActivityTone,
  getReliabilityTone,
  truncateId,
} from "../utils";

const categories = ["All", "Bridge Donor", "Emergency Donor", "Guest", "Volunteer"];

function Field({ label, value }) {
  return (
    <div className="field-row">
      <span>{label}</span>
      <strong>{value ?? "—"}</strong>
    </div>
  );
}

export default function Donors() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [donors, setDonors] = useState([]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [selected, setSelected] = useState(null);
  const [conversationSnippets, setConversationSnippets] = useState([]);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationError, setConversationError] = useState("");

  const loadDonors = async () => {
    setError("");
    try {
      const data = await getDonors({ limit: 7000 });
      setDonors(Array.isArray(data.donors) ? data.donors : []);
    } catch (err) {
      setError(err?.response?.data?.error || err?.response?.data?.detail || err.message || "Failed to load donors");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      loadDonors();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    const loadConversation = async () => {
      setConversationLoading(true);
      setConversationError("");
      try {
        const data = await getConversations(selected.user_id);
        if (!active) return;
        setConversationSnippets((data.history || []).slice(-3).reverse());
      } catch (err) {
        if (!active) return;
        setConversationError(
          err?.response?.data?.error || err?.response?.data?.detail || err.message || "Failed to load conversation snippets"
        );
        setConversationSnippets([]);
      } finally {
        if (active) setConversationLoading(false);
      }
    };
    const timer = setTimeout(() => {
      loadConversation();
    }, 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [selected]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return donors.filter((donor) => {
      const matchesCategory = category === "All" || donor.donor_category === category;
      const matchesQuery =
        !query ||
        String(donor.user_id || "").toLowerCase().includes(query) ||
        String(donor.blood_group || "").toLowerCase().includes(query);
      return matchesCategory && matchesQuery;
    });
  }, [donors, category, search]);

  if (loading) return <Spinner label="Loading donors..." />;
  if (error) return <ErrorState error={error} onRetry={loadDonors} />;

  return (
    <div className="page">
      <PageHeader title="Donors" subtitle="Search and inspect donor profiles, reliability, and recent conversations." />

      <Card className="toolbar">
        <input
          className="input"
          placeholder="Search by donor ID or blood group"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="chip-row">
          {categories.map((item) => (
            <button
              key={item}
              type="button"
              className={`chip ${category === item ? "active" : ""}`}
              onClick={() => setCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </Card>

      <Card className="panel">
        <div className="panel-head">
          <h2>Donor Directory</h2>
          <span>{filtered.length} shown</span>
        </div>
        <div className="table-wrap donors-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Donor ID</th>
                <th>Blood Group</th>
                <th>Category</th>
                <th>Reliability</th>
                <th>Donations</th>
                <th>Eligibility</th>
                <th>Last Donation</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((donor) => {
                const score = Number(donor.normalized_reliability_score || 0);
                const tone = getReliabilityTone(score);
                return (
                  <tr key={donor.user_id} onClick={() => setSelected(donor)}>
                    <td title={donor.user_id}>{truncateId(donor.user_id)}</td>
                    <td>{donor.blood_group || "—"}</td>
                    <td>
                      <Badge tone={getActivityTone(donor.donor_category === "Bridge Donor" ? "active" : donor.user_donation_active_status)}>
                        {donor.donor_category || "—"}
                      </Badge>
                    </td>
                    <td>
                      <div className="progress-cell">
                        <div className="progress-track">
                          <div
                            className={`progress-fill ${tone}`}
                            style={{ width: `${Math.round(score * 100)}%` }}
                          />
                        </div>
                        <span>{score.toFixed(2)}</span>
                      </div>
                    </td>
                    <td>{donor.donations_till_date ?? "—"}</td>
                    <td>
                      <Badge tone={String(donor.eligibility_status || "").toLowerCase().includes("not") ? "danger" : "success"}>
                        {donor.eligibility_status || "eligible"}
                      </Badge>
                    </td>
                    <td>{formatDate(donor.last_donation_date)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title="Donor Profile" width={400}>
        {selected ? (
          <div className="drawer-stack">
            <div className="mono-box" title={selected.user_id}>
              {selected.user_id}
            </div>

            <div className="detail-grid">
              <Field label="Blood Group" value={selected.blood_group} />
              <Field label="Category" value={selected.donor_category} />
              <Field label="Reliability" value={Number(selected.normalized_reliability_score || 0).toFixed(2)} />
              <Field label="Donations" value={selected.donations_till_date} />
              <Field label="Eligibility" value={selected.eligibility_status || "eligible"} />
              <Field label="Active Status" value={selected.user_donation_active_status} />
              <Field label="Last Donation" value={formatDateTime(selected.last_donation_date)} />
              <Field label="Next Eligible" value={formatDateTime(selected.next_eligible_date)} />
            </div>

            <div>
              <div className="section-head">
                <h3>Conversation Snippets</h3>
                <span>{conversationSnippets.length}</span>
              </div>
              {conversationLoading ? (
                <Spinner label="Loading conversation..." />
              ) : conversationError ? (
                <ErrorState error={conversationError} />
              ) : conversationSnippets.length ? (
                <div className="snippet-list">
                  {conversationSnippets.map((item, index) => (
                    <div className="snippet" key={`${item.timestamp}-${index}`}>
                      <Badge tone={item.role === "assistant" ? "danger" : "muted"}>
                        {item.role}
                      </Badge>
                      <small>{truncateId(item.patient_id)}</small>
                      <p>{item.message}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">No conversation history yet.</div>
              )}
            </div>

            <button
              type="button"
              className="btn btn-primary"
              onClick={() => navigate(`/conversations?donor_id=${encodeURIComponent(selected.user_id)}`)}
            >
              View Full Conversation
            </button>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
