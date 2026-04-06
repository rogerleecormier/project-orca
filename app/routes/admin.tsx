import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { getAdminConsoleData, getViewerContext, setAccountAdminStatus } from "../server/functions";
import { OrcaMark } from "../components/icons/orca-mark";

export const Route = createFileRoute("/admin")({
  loader: async () => {
    const viewer = await getViewerContext();

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    if (!viewer.isAdminParent) {
      throw redirect({ to: "/" });
    }

    return getAdminConsoleData();
  },
  component: AdminConsolePage,
});

type MemberRow = {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  isAdmin: boolean;
};

const columnHelper = createColumnHelper<MemberRow>();

function AdminConsolePage() {
  const router = useRouter();
  const data = Route.useLoaderData();

  const table = useReactTable({
    data: data.members,
    columns: [
      columnHelper.accessor("name", {
        header: "Member",
        cell: (info) => (
          <div>
            <p className="font-medium text-slate-900">{info.getValue()}</p>
            <p className="text-xs text-slate-500">{info.row.original.email}</p>
          </div>
        ),
      }),
      columnHelper.accessor("role", {
        header: "Membership",
        cell: (info) => (
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs uppercase tracking-wide text-slate-700">
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor("createdAt", {
        header: "Joined",
        cell: (info) => new Date(info.getValue()).toLocaleDateString(),
      }),
      columnHelper.display({
        id: "admin-toggle",
        header: "Admin",
        cell: (info) => {
          const row = info.row.original;
          return (
            <button
              className={`rounded-xl px-3 py-1.5 text-xs font-medium ${
                row.isAdmin
                  ? "bg-amber-100 text-amber-900 hover:bg-amber-200"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
              onClick={async () => {
                await setAccountAdminStatus({
                  data: {
                    userId: row.userId,
                    isAdmin: !row.isAdmin,
                  },
                });
                await router.invalidate();
              }}
            >
              {row.isAdmin ? "Admin Enabled" : "Make Admin"}
            </button>
          );
        },
      }),
    ],
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="space-y-6">
      <section className="orca-hero orca-wave rounded-2xl border border-slate-200 bg-white/90 p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.2em] text-cyan-700">Admin Console</p>
        <div className="mt-2 flex items-center gap-3">
          <span className="orca-icon-chip" aria-hidden="true">
            <OrcaMark className="h-6 w-6" alt="" />
          </span>
          <h1 className="text-2xl font-semibold text-slate-900">
            {data.organization?.name ?? "Home Pod"}
          </h1>
        </div>
        <p className="mt-2 text-sm text-slate-600">
          Toggle which parent accounts have admin access to menus and management views.
        </p>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white/90 shadow-sm">
        <div className="border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">User Management</h2>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-6 py-4 text-sm text-slate-700">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {data.members.length === 0 ? (
          <p className="px-6 py-5 text-sm text-slate-500">No users are assigned to this Home Pod yet.</p>
        ) : null}
      </section>
    </div>
  );
}
