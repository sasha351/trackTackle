// One animated loader, reused wherever there's a wait between action and result.
// `label` renders as visible text beside the spinner; role="status" announces it.
export default function Spinner({ label }: { label?: string }) {
  return (
    <span className="loader" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}
