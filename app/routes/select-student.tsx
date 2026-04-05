import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  continueAsParent,
  createStudentProfileInline,
  getStudentSelectionOptions,
  getViewerContext,
} from "../server/functions";

export const Route = createFileRoute("/select-student")({
  loader: async () => {
    const viewer = await getViewerContext();

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    if (viewer.activeRole === "student") {
      throw redirect({ to: "/student" });
    }

    return getStudentSelectionOptions();
  },
  component: SelectStudentPage,
});

function SelectStudentPage() {
  const data = Route.useLoaderData();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<"parent" | "create" | null>(null);

  // Create student form state
  const [studentName, setStudentName] = useState("");
  const [studentGrade, setStudentGrade] = useState("");
  const [studentPin, setStudentPin] = useState("");

  const proceedAsParent = async () => {
    setError(null);
    setLoading("parent");

    try {
      await continueAsParent();
      window.location.assign("/");
    } catch {
      setError("Could not continue as parent.");
    } finally {
      setLoading(null);
    }
  };

  const createStudent = async () => {
    setError(null);

    if (!studentName.trim() || !studentGrade.trim() || !studentPin.trim()) {
      setError("Student name, grade, and PIN are required.");
      return;
    }

    if (!/^\d{4,6}$/.test(studentPin)) {
      setError("PIN must be 4-6 digits.");
      return;
    }

    setLoading("create");
    try {
      await createStudentProfileInline({
        data: {
          displayName: studentName.trim(),
          gradeLevel: studentGrade.trim(),
          pin: studentPin,
        },
      });

      setStudentName("");
      setStudentGrade("");
      setStudentPin("");
      setError(null);
      window.location.reload();
    } catch (err) {
      setError("Failed to create student.");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="mx-auto min-h-[75vh] w-full max-w-7xl py-8 px-4">
      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Step 2</p>
          <h1 className="mt-2 text-2xl font-semibold text-slate-900">View as Parent</h1>
          <p className="mt-2 text-sm text-slate-600">
            Enter the parent view with curriculum tools and management menus.
          </p>

          <button
            onClick={() => {
              void proceedAsParent();
            }}
            disabled={loading !== null}
            className="mt-5 w-full rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {loading === "parent" ? "Loading..." : "Open Parent View"}
          </button>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-700">Step 2</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Create New Student</h2>
          <p className="mt-2 text-sm text-slate-600">Add a new student profile.</p>

          <div className="mt-5 space-y-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Student Name</span>
              <input
                value={studentName}
                onChange={(event) => setStudentName(event.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                placeholder="Sarah"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Grade Level</span>
              <input
                value={studentGrade}
                onChange={(event) => setStudentGrade(event.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                placeholder="9"
              />
              <p className="mt-1 text-xs text-slate-500">Required for every student profile.</p>
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-slate-700">Student PIN</span>
              <input
                type="password"
                inputMode="numeric"
                value={studentPin}
                onChange={(event) => {
                  const val = event.target.value.replace(/\D/g, "").slice(0, 6);
                  setStudentPin(val);
                }}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-800"
                placeholder="1234"
                maxLength="6"
              />
              <p className="mt-1 text-xs text-slate-500">4-6 digits.</p>
            </label>
          </div>

          <button
            onClick={() => {
              void createStudent();
            }}
            disabled={loading !== null}
            className="mt-5 w-full rounded-xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {loading === "create" ? "Creating..." : "Create Student"}
          </button>

          {data.profiles.length > 0 ? (
            <p className="mt-4 text-sm text-slate-600">
              Switch between parent and student views from the header menu after entering the parent portal.
            </p>
          ) : null}
        </section>

        {error ? <p className="md:col-span-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 font-medium">{error}</p> : null}
      </div>
    </div>
  );
}
