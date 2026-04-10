import { useState } from "react";
import { Link, createFileRoute, redirect } from "@tanstack/react-router";
import { getLessonsData, getViewerContext } from "../server/functions";
import { ParentPageHeader } from "../components/parent-page-header";

type LessonsLoaderData = Awaited<ReturnType<typeof getLessonsData>>;
type TreeRow = LessonsLoaderData["trees"][number];
type NodeRow = TreeRow["nodes"][number];

export const Route = createFileRoute("/lessons")({
  loader: async (): Promise<LessonsLoaderData> => {
    const viewer = await getViewerContext();
    if (!viewer.isAuthenticated) throw redirect({ to: "/login" });
    if (viewer.activeRole === "student") throw redirect({ to: "/student" });
    return getLessonsData();
  },
  component: LessonsPage,
});

const NODE_TYPE_LABELS: Record<string, string> = {
  lesson: "Lesson",
  milestone: "Milestone",
  boss: "Assessment",
  branch: "Branch",
  elective: "Elective",
};

const NODE_TYPE_COLORS: Record<string, string> = {
  lesson: "bg-cyan-50 text-cyan-800 border-cyan-200",
  milestone: "bg-violet-50 text-violet-800 border-violet-200",
  boss: "bg-rose-50 text-rose-800 border-rose-200",
  branch: "bg-amber-50 text-amber-800 border-amber-200",
  elective: "bg-emerald-50 text-emerald-800 border-emerald-200",
};

function NodeRow({ node, treeId }: { node: NodeRow; treeId: string }) {
  const typeClass = NODE_TYPE_COLORS[node.nodeType] ?? "bg-slate-50 text-slate-700 border-slate-200";
  const typeLabel = NODE_TYPE_LABELS[node.nodeType] ?? node.nodeType;

  return (
    <Link
      to="/skill-tree/$treeId"
      params={{ treeId }}
      className="flex items-center gap-3 rounded-xl px-4 py-3 hover:bg-slate-50 transition group"
    >
      <span className="text-xl w-8 text-center shrink-0">{node.icon ?? "📚"}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-900 truncate group-hover:text-cyan-700">
          {node.title}
        </p>
        {node.description ? (
          <p className="text-xs text-slate-500 truncate mt-0.5">{node.description}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${typeClass}`}>
          {typeLabel}
        </span>
        {node.assignmentCount > 0 ? (
          <span className="text-xs text-slate-400">{node.assignmentCount} tasks</span>
        ) : null}
        <span className="text-xs text-amber-600 font-medium">{node.xpReward} XP</span>
      </div>
    </Link>
  );
}

function TreeSection({ tree }: { tree: TreeRow }) {
  const [collapsed, setCollapsed] = useState(false);
  const lessonCount = tree.nodes.filter((n) => n.nodeType === "lesson" || n.nodeType === "elective").length;
  const totalCount = tree.nodes.length;

  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden orca-glass-panel">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-slate-50 transition text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-lg">{collapsed ? "▶" : "▼"}</span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-slate-900 truncate">{tree.title}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {totalCount} nodes · {lessonCount} lessons
              {tree.subject ? ` · ${tree.subject}` : ""}
              {tree.gradeLevel ? ` · Grade ${tree.gradeLevel}` : ""}
            </p>
          </div>
        </div>
        <Link
          to="/skill-tree/$treeId"
          params={{ treeId: tree.id }}
          onClick={(e) => e.stopPropagation()}
          className="ml-3 shrink-0 text-xs text-cyan-600 hover:text-cyan-800 font-medium"
        >
          Open Map →
        </Link>
      </button>

      {!collapsed && (
        <div className="border-t border-slate-100 divide-y divide-slate-50">
          {tree.nodes.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-400 italic">No nodes yet.</p>
          ) : (
            tree.nodes.map((node) => (
              <NodeRow key={node.id} node={node} treeId={tree.id} />
            ))
          )}
        </div>
      )}
    </section>
  );
}

function LessonsPage() {
  const { trees } = Route.useLoaderData() as LessonsLoaderData;
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const nodeTypeOptions = ["all", "lesson", "milestone", "boss", "branch", "elective"];

  const filteredTrees = trees
    .map((tree) => ({
      ...tree,
      nodes: tree.nodes.filter((n) => {
        const matchesType = filter === "all" || n.nodeType === filter;
        const matchesSearch =
          !search ||
          n.title.toLowerCase().includes(search.toLowerCase()) ||
          (n.description ?? "").toLowerCase().includes(search.toLowerCase());
        return matchesType && matchesSearch;
      }),
    }))
    .filter((tree) => tree.nodes.length > 0 || (!search && filter === "all"));

  const totalNodes = trees.reduce((acc, t) => acc + t.nodes.length, 0);
  const totalLessons = trees.reduce(
    (acc, t) => acc + t.nodes.filter((n) => n.nodeType === "lesson" || n.nodeType === "elective").length,
    0,
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <ParentPageHeader
        title="Lessons"
        description={`${totalNodes} nodes across ${trees.length} skill maps with ${totalLessons} lessons and electives ready to browse.`}
        action={(
          <Link
            to="/curriculum-builder"
            className="rounded-xl bg-cyan-700 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-cyan-800"
          >
            Open AI Builder
          </Link>
        )}
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Search lessons…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-56 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-300"
        />
        <div className="flex flex-wrap gap-1">
          {nodeTypeOptions.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setFilter(opt)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                filter === opt
                  ? "bg-cyan-600 text-white border-cyan-600"
                  : "bg-white text-slate-600 border-slate-200 hover:border-cyan-300"
              }`}
            >
              {opt === "all" ? "All" : NODE_TYPE_LABELS[opt] ?? opt}
            </button>
          ))}
        </div>
      </div>

      {/* Trees */}
      {filteredTrees.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white py-16 text-center">
          <p className="text-sm text-slate-400">
            {trees.length === 0
              ? "No skill maps yet. Build your first curriculum with the AI Builder."
              : "No lessons match your filters."}
          </p>
          {trees.length === 0 && (
            <Link
              to="/curriculum-builder"
              className="mt-4 inline-block rounded-xl bg-cyan-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-cyan-700"
            >
              Open AI Builder
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredTrees.map((tree) => (
            <TreeSection key={tree.id} tree={tree} />
          ))}
        </div>
      )}
    </div>
  );
}
