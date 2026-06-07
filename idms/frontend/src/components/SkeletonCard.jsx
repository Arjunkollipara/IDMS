function SkeletonCard({ lines = 3 }) {
  return (
    <div className="card">
      <div className="flex flex-col gap-2">
        {Array.from({ length: lines }).map((_, index) => (
          <div key={index} className="skeleton" />
        ))}
      </div>
    </div>
  );
}

export default SkeletonCard;
export { SkeletonCard };
