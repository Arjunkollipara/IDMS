function LoadingSpinner({ label = 'Loading' }) {
  return <div className="spinner" role="status" aria-label={label} />;
}

export default LoadingSpinner;
export { LoadingSpinner };
