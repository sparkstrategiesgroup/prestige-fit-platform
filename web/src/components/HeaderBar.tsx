type Props = {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
};

export function HeaderBar({ title, subtitle, right }: Props) {
  return (
    <header className="bg-surface border-b border-border">
      <div className="max-w-page mx-auto px-5 py-4 flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-bold text-text-primary leading-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="text-[13px] text-text-secondary mt-0.5">{subtitle}</p>
          )}
        </div>
        {right && <div className="text-[13px] text-text-muted">{right}</div>}
      </div>
    </header>
  );
}
