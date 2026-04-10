import { useRef, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { ParentPageHeader } from "../components/parent-page-header";
import {
  aiSuggestFullCurriculum,
  createSkillTree,
  getCurriculumBuilderData,
  getSkillTreesForOrg,
  getStudentSkillTrees,
  getViewerContext,
} from "../server/functions";

export const Route = createFileRoute("/skill-trees")({
  loader: async () => {
    const viewer = await getViewerContext();

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    // Student path: redirect to first tree or show their trees
    if (viewer.activeRole === "student") {
      if (!viewer.profileId) throw redirect({ to: "/student" });
      const studentTrees = await getStudentSkillTrees({ data: { profileId: viewer.profileId } });
      if (studentTrees.length === 1) {
        throw redirect({ to: "/skill-tree/$treeId", params: { treeId: studentTrees[0]!.tree.id } });
      }
      return { studentTrees, treesData: null, classes: [] };
    }

    const [treesData, curriculumData] = await Promise.all([
      getSkillTreesForOrg(),
      getCurriculumBuilderData(),
    ]);

    return { treesData, classes: curriculumData.classes, studentTrees: null };
  },
  component: SkillTreesIndexPage,
});

type LoaderData = Awaited<ReturnType<typeof Route.useLoaderData>>;
type SkillTree = NonNullable<LoaderData["treesData"]>["trees"][number];
type ClassRow = LoaderData["classes"][number];
type StudentTreeRow = NonNullable<LoaderData["studentTrees"]>[number];

// ── Card ──────────────────────────────────────────────────────────────────────

function SkillTreeCard({
  tree,
  classTitle,
}: {
  tree: SkillTree;
  classTitle: string | null;
}) {
  const router = useRouter();

  return (
    <article className="flex flex-col rounded-2xl border border-slate-200 bg-white/90 p-5 shadow-sm transition hover:shadow-md">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900 leading-snug">{tree.title}</h2>
        <div className="flex flex-wrap gap-1 shrink-0">
          {tree.subject ? (
            <span className="rounded-full bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-800 border border-cyan-200">
              {tree.subject}
            </span>
          ) : null}
          {tree.schoolYear ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 border border-slate-200">
              {tree.schoolYear}
            </span>
          ) : null}
        </div>
      </div>

      {tree.gradeLevel ? (
        <p className="mt-1 text-sm text-slate-500">Grade {tree.gradeLevel}</p>
      ) : null}

      {tree.description ? (
        <p className="mt-2 text-sm text-slate-600 line-clamp-2">{tree.description}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <span>{(tree as SkillTree & { nodeCount: number }).nodeCount ?? 0} nodes</span>
        {classTitle ? (
          <span className="text-slate-400">·</span>
        ) : null}
        {classTitle ? <span>{classTitle}</span> : null}
      </div>

      <div className="mt-4 pt-3 border-t border-slate-100">
        <button
          type="button"
          onClick={() => router.navigate({ to: "/skill-tree/$treeId", params: { treeId: tree.id } })}
          className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 transition"
        >
          Open
        </button>
      </div>
    </article>
  );
}

// ── Create Modal ──────────────────────────────────────────────────────────────

function CreateSkillTreeModal({
  classes,
  onClose,
}: {
  classes: ClassRow[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [gradeLevel, setGradeLevel] = useState("");
  const [classId, setClassId] = useState("");
  const [schoolYear, setSchoolYear] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formValid = title.trim().length > 0;

  async function handleCreate() {
    if (!formValid) return;
    setError(null);
    setCreating(true);
    try {
      const result = await createSkillTree({
        data: {
          title: title.trim(),
          subject: subject.trim() || undefined,
          gradeLevel: gradeLevel.trim() || undefined,
          classId: classId || undefined,
          schoolYear: schoolYear.trim() || undefined,
          description: description.trim() || undefined,
        },
      });
      await router.navigate({ to: "/skill-tree/$treeId", params: { treeId: result.treeId } });
    } catch {
      setError("Failed to create skill map. Please try again.");
      setCreating(false);
    }
  }

  async function handleAiGenerate() {
    if (!formValid || !subject.trim() || !gradeLevel.trim()) {
      setError("Subject and grade level are required for AI generation.");
      return;
    }
    setError(null);
    setAiGenerating(true);
    try {
      const result = await createSkillTree({
        data: {
          title: title.trim(),
          subject: subject.trim(),
          gradeLevel: gradeLevel.trim(),
          classId: classId || undefined,
          schoolYear: schoolYear.trim() || undefined,
          description: description.trim() || undefined,
        },
      });

      await aiSuggestFullCurriculum({
        data: {
          treeId: result.treeId,
          subject: subject.trim(),
          gradeLevel: gradeLevel.trim(),
          depth: 4,
          seedTopic: subject.trim(),
        },
      });

      await router.navigate({ to: "/skill-tree/$treeId", params: { treeId: result.treeId } });
    } catch {
      setError("AI generation failed. Try creating a blank tree instead.");
      setAiGenerating(false);
    }
  }

  const busy = creating || aiGenerating;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-slate-900">New Skill Map</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Title <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              placeholder="e.g. Elementary Biology"
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none disabled:opacity-60"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Subject</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={busy}
                placeholder="Biology, US History…"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none disabled:opacity-60"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Grade Level</label>
              <input
                type="text"
                value={gradeLevel}
                onChange={(e) => setGradeLevel(e.target.value)}
                disabled={busy}
                placeholder="6, 7–8, K…"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none disabled:opacity-60"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Class</label>
              <select
                value={classId}
                onChange={(e) => setClassId(e.target.value)}
                disabled={busy}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none disabled:opacity-60"
              >
                <option value="">— none —</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">School Year</label>
              <input
                type="text"
                value={schoolYear}
                onChange={(e) => setSchoolYear(e.target.value)}
                disabled={busy}
                placeholder="2025–26"
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none disabled:opacity-60"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
              rows={2}
              placeholder="Optional description…"
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-cyan-500 focus:outline-none disabled:opacity-60 resize-none"
            />
          </div>
        </div>

        {error ? (
          <p className="mt-3 rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        ) : null}

        {aiGenerating ? (
          <p className="mt-3 rounded-xl bg-cyan-50 border border-cyan-200 px-3 py-2 text-sm text-cyan-700 animate-pulse">
            Generating curriculum tree… this may take a few seconds.
          </p>
        ) : null}

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!formValid || busy}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create blank tree"}
          </button>
          <button
            type="button"
            onClick={() => void handleAiGenerate()}
            disabled={!formValid || busy}
            className="rounded-xl bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-700 disabled:opacity-50"
          >
            {aiGenerating ? "Generating…" : "✦ AI Generate full curriculum"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function StudentSkillMapsPage({ trees }: { trees: StudentTreeRow[] }) {
  if (trees.length === 0) {
    return (
      <div className="space-y-6">
        <section className="orca-hero orca-wave rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Student Workspace</p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-900">My Skill Maps</h1>
        </section>
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-sm text-slate-500">
          Your teacher hasn't set up any skill maps yet.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="orca-hero orca-wave rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Student Workspace</p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-900">My Skill Maps</h1>
      </section>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {trees.map(({ tree, completedNodes, totalNodes, earnedXp }) => (
          <article
            key={tree.id}
            className="flex flex-col rounded-2xl border border-slate-200 bg-white/90 p-5 shadow-sm transition hover:shadow-md"
          >
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-lg font-semibold leading-snug text-slate-900">{tree.title}</h2>
              {tree.subject ? (
                <span className="shrink-0 rounded-full border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-xs font-medium text-cyan-800">
                  {tree.subject}
                </span>
              ) : null}
            </div>
            <div className="mt-3 space-y-1">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-all"
                  style={{ width: totalNodes > 0 ? `${Math.round((completedNodes / totalNodes) * 100)}%` : "0%" }}
                />
              </div>
              <p className="text-xs text-slate-500">
                {completedNodes}/{totalNodes} nodes · {earnedXp} XP earned
              </p>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-100">
              <Link
                to="/skill-tree/$treeId"
                params={{ treeId: tree.id }}
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 transition"
              >
                Open →
              </Link>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function SkillTreesIndexPage() {
  const { treesData, classes, studentTrees } = Route.useLoaderData();
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Student view
  if (studentTrees !== null) {
    return <StudentSkillMapsPage trees={studentTrees} />;
  }

  const classTitleMap = new Map(classes.map((c) => [c.id, c.title]));
  const trees = treesData!.trees;

  return (
    <div className="space-y-6">
      <ParentPageHeader
        title="Skill Maps"
        description="Build RPG-style curriculum pathways with required main spines, optional branches, and milestone progression."
        action={(
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="rounded-xl bg-cyan-700 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-cyan-800"
          >
            New Skill Map
          </button>
        )}
      />

      <section>
        {trees.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-sm text-slate-500">
            No skill maps yet. Create your first one.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {trees.map((tree) => (
              <SkillTreeCard
                key={tree.id}
                tree={tree}
                classTitle={tree.classId ? (classTitleMap.get(tree.classId) ?? null) : null}
              />
            ))}
          </div>
        )}
      </section>

      {showCreateModal ? (
        <CreateSkillTreeModal
          classes={classes}
          onClose={() => setShowCreateModal(false)}
        />
      ) : null}
    </div>
  );
}
