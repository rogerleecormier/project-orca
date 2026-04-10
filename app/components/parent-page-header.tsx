import type { ReactNode } from "react";
import { OrcaMark } from "./icons/orca-mark";

type ParentPageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
};

export function ParentPageHeader({
  eyebrow = "Parent Workspace",
  title,
  description,
  action,
}: ParentPageHeaderProps) {
  return (
    <section className="orca-hero orca-wave rounded-[28px] border border-slate-200 bg-white/90 p-6 shadow-sm sm:p-7">
      {/* Sandy accent bar across top */}
      <div className="orca-sand-bar mb-4" aria-hidden="true" />

      <div className="flex items-center gap-2">
        <p className="text-xs uppercase tracking-[0.24em] text-cyan-700">{eyebrow}</p>
        <span className="orca-sand-dot" aria-hidden="true" />
      </div>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span className="orca-icon-chip" aria-hidden="true">
              <OrcaMark className="h-6 w-6" alt="" />
            </span>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-[2.15rem]">
              {title}
            </h1>
          </div>
          {description ? <div className="mt-3 text-base text-slate-600">{description}</div> : null}
        </div>

        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </section>
  );
}
