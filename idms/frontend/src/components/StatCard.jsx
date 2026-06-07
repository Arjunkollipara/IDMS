function StatCard({ tone = 'gray', value, label, sublabel }) {
  return (
    <div className={`stat-card ${tone}`}>
      <div className="stat-number">{value}</div>
      <div className="stat-label">{label}</div>
      {sublabel ? <div className="stat-sub">{sublabel}</div> : null}
    </div>
  );
}

export default StatCard;
export { StatCard };
