import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { getRequest } from "@tanstack/react-start/server";
import { getDb } from "../db/client";
import * as schema from "../db/schema";

export type ActiveRole = "admin" | "parent" | "student";

type CookieRoleSession = {
  role: ActiveRole;
  userId?: string;
  organizationId?: string;
  profileId?: string;
  isAdminParent?: boolean;
};

function parseCookieHeader(cookieHeader: string | null) {
  const parsed: Record<string, string> = {};

  if (!cookieHeader) {
    return parsed;
  }

  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const [rawKey, ...rawValue] = pair.trim().split("=");
    if (!rawKey || rawValue.length === 0) {
      continue;
    }

    parsed[rawKey] = decodeURIComponent(rawValue.join("="));
  }

  return parsed;
}

function getCookieRoleSession(): CookieRoleSession | null {
  const request = getRequest();
  const cookies = parseCookieHeader(request.headers.get("cookie"));
  const role = cookies.proorca_role;

  if (role !== "admin" && role !== "parent" && role !== "student") {
    return null;
  }

  return {
    role,
    userId: cookies.proorca_user_id || undefined,
    organizationId: cookies.proorca_org_id || undefined,
    profileId: cookies.proorca_profile_id || undefined,
    isAdminParent: cookies.proorca_is_admin_parent === "1",
  };
}

export const auth = betterAuth({
  database: drizzleAdapter(getDb(), {
    provider: "sqlite",
    schema,
    usePlural: true,
  }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    tanstackStartCookies(),
    admin({
      defaultRole: "user",
      adminRoles: ["admin"],
      impersonationSessionDuration: 60 * 60,
    }),
    organization({
      creatorRole: "parent",
      schema: {
        organization: { modelName: "authOrganizations" },
        member: { modelName: "authMembers" },
        invitation: { modelName: "authInvitations" },
        session: {
          fields: {
            activeOrganizationId: "activeOrganizationId",
            activeTeamId: "activeTeamId",
          },
        },
      },
    }),
  ],
});

export async function getAuthSession() {
  const request = getRequest();
  const session = await (auth.api as any).getSession({
    headers: request.headers,
  });
  return session as
    | {
        session: {
          userId: string;
          activeOrganizationId?: string;
          impersonatedBy?: string;
        };
        user: {
          id: string;
          role?: string;
        };
      }
    | null;
}

export function deriveActiveRole(
  session:
    | {
        session: { impersonatedBy?: string };
        user: { role?: string };
      }
    | null,
): ActiveRole {
  if (!session) {
    return "parent";
  }

  if (session.session.impersonatedBy) {
    return "student";
  }

  if (session.user.role === "admin") {
    return "admin";
  }

  return "parent";
}

export async function getRoleContext() {
  const session = await getAuthSession();

  if (session) {
    return {
      isAuthenticated: true,
      session,
      activeRole: deriveActiveRole(session),
      userId: session.user.id,
      organizationId: session.session.activeOrganizationId,
      profileId: undefined as string | undefined,
      isAdminParent: session.user.role === "admin",
    };
  }

  const cookieRoleSession = getCookieRoleSession();

  if (!cookieRoleSession) {
    return {
      isAuthenticated: false,
      session: null,
      activeRole: "parent" as ActiveRole,
      userId: undefined as string | undefined,
      organizationId: undefined as string | undefined,
      profileId: undefined as string | undefined,
      isAdminParent: false,
    };
  }

  return {
    isAuthenticated: true,
    session: null,
    activeRole: cookieRoleSession.role,
    userId: cookieRoleSession.userId,
    organizationId: cookieRoleSession.organizationId,
    profileId: cookieRoleSession.profileId,
    isAdminParent: cookieRoleSession.isAdminParent ?? false,
  };
}

export async function requireActiveRole(allowed: ActiveRole[]) {
  const roleContext = await getRoleContext();

  if (!roleContext.isAuthenticated) {
    throw new Error("UNAUTHORIZED");
  }

  const computedRole = roleContext.activeRole;

  if (!allowed.includes(computedRole)) {
    throw new Error("FORBIDDEN");
  }

  const userId = roleContext.userId ?? "demo-user";

  return {
    session: {
      userId,
      activeOrganizationId: roleContext.organizationId,
      impersonatedBy: computedRole === "student" ? "cookie-session" : undefined,
      profileId: roleContext.profileId,
    },
    user: {
      id: userId,
      role: computedRole === "admin" ? "admin" : "user",
    },
    activeRole: computedRole,
    isCookieSession: !roleContext.session,
  };
}
