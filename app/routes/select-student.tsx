import { createFileRoute, redirect } from "@tanstack/react-router";
import { getViewerContext } from "../server/functions";

export const Route = createFileRoute("/select-student")({
  loader: async () => {
    const viewer = await getViewerContext();

    if (!viewer.isAuthenticated) {
      throw redirect({ to: "/login" });
    }

    throw redirect({ to: viewer.activeRole === "student" ? "/student" : "/" });
  },
  component: () => null,
});
