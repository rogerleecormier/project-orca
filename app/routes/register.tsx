import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/register")({
  loader: async () => {
    throw redirect({ to: "/login" });
  },
  component: () => null,
});
