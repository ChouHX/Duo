import type { ReactNode } from "react";

export function Section({
  title,
  info,
  extra,
  children,
  className = "",
}: {
  title: string;
  info?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`section ${className}`.trim()}>
      <div className="section-title">
        <span className="section-heading">
          <h2>{title}</h2>
          {info}
        </span>
        {extra}
      </div>
      {children}
    </section>
  );
}
