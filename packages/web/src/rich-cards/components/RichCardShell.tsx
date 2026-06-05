import type { ReactNode } from "react";

export function RichCardShell({
  title,
  subtitle,
  className = "",
  children,
}: {
  title?: string;
  subtitle?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <article className={`rich-card ${className}`.trim()}>
      {(title || subtitle) && (
        <header className="rich-card__header">
          {title && <h3 className="rich-card__title">{title}</h3>}
          {subtitle && <p className="rich-card__subtitle">{subtitle}</p>}
        </header>
      )}
      {children}
    </article>
  );
}
