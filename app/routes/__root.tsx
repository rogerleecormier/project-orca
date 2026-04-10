/// <reference types="vite/client" />
import type { ReactNode } from "react";
import {
  Outlet,
  createRootRoute,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { AppShell } from "../components/app-shell";
import { QueryProvider } from "../components/query-provider";
import { CurriculumProgressProvider } from "../components/CurriculumProgressPanel";
import { getRoleSwitcherData } from "../server/functions";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  staleTime: 0,
  preloadStaleTime: 0,
  shouldReload: () => true,
  loader: () => getRoleSwitcherData(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "ProOrca - Homeschool LMS" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  const shellData = Route.useLoaderData();

  return (
    <RootDocument>
      <QueryProvider>
        <CurriculumProgressProvider>
          <AppShell
            isAuthenticated={shellData.isAuthenticated}
            initialRole={shellData.activeRole}
            isAdminParent={shellData.isAdminParent}
            activeProfileId={shellData.activeProfileId}
            profiles={shellData.profiles}
            pendingRewardsCount={shellData.pendingRewardsCount ?? 0}
          >
            <Outlet />
          </AppShell>
        </CurriculumProgressProvider>
      </QueryProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="orca-theme">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
