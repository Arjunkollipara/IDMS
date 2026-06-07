function EmptyState({
  title = 'Nothing to show',
  message = 'No records matched the current filters.',
  children,
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{message}</p>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

export default EmptyState;
export { EmptyState };
