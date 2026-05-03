import type { ReactNode } from "react";

export function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <article className="metric">
      {icon}
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </article>
  );
}

export function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <span className="info-tile">
      <em>{label}</em>
      <strong>{value}</strong>
    </span>
  );
}
export function TabButton({
  active,
  icon,
  label,
  meta,
  onClick
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`tab-button ${active ? "active" : ""}`} aria-pressed={active} onClick={onClick}>
      {icon}
      <span>{label}</span>
      <strong>{meta}</strong>
    </button>
  );
}
export function EmptyState({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}
