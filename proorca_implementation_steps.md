# Project Orca (ProOrca) Implementation Roadmap

**Execution Mode:** Sequential Sprint (24 Steps)
**Target Environment:** Cloudflare Workers (Edge)
**Identity Model:** Parent-Primary with Student Sub-profiles (Impersonation)

## Phase 1: Environment & Core Infrastructure

1. **Initialize Project:** Scaffold TanStack Start with Tailwind CSS and TypeScript.
2. **Cloudflare Configuration:** Configure `wrangler.toml` with D1, R2, and Workers AI bindings.
3. **ORM Setup:** Install Drizzle ORM and Drizzle Kit; configure for D1 (SQLite) compatibility.
4. **Edge Compatibility Check:** Ensure `nodejs_compat` is active and project builds for the Workers runtime.

## Phase 2: The "Home Pod" Data Layer

1. **Schema Definition (Identity):** Define `users`, `organizations` (Home Pods), and `memberships` tables.
2. **Schema Definition (Profiles):** Implement the `profiles` table to support sub-accounts (Student metadata + PIN hashes).
3. **Schema Definition (LMS):** Define `classes`, `assignments`, and `submissions` tables scoped to `organization_id`.
4. **Migration Execution:** Generate and run the initial D1 migration via `drizzle-kit`.

## Phase 3: Identity & Authentication (Better Auth)

1. **Better Auth Core:** Initialize Better Auth with the Drizzle adapter.
2. **Organization Plugin:** Configure the "Home Pod" organizational logic for family-level multi-tenancy.
3. **Sub-account Logic:** Implement custom profile creation logic where Parents generate Student sub-profiles.
4. **Impersonation Engine:** Enable the Impersonation plugin to allow Parent-to-Student role switching.
5. **Security Middleware:** Build the `activeRole` verification logic for server functions.

## Phase 4: Core Layout & Navigation

1. **Root Layout:** Build the global Shadcn sidebar and main viewport using TanStack Router.
2. **Role Switcher UI:** Implement the header component to toggle between Parent and Student "Views."
3. **PIN-Guard Implementation:** Create the `InputOTP` modal that triggers when switching from Student to Parent/Admin roles.

## Phase 5: Functional Modules (Admin & Parent)

1. **Admin Console:** Implement the "Home Pod" settings and user management using TanStack Table.
2. **Class Engine:** Build the class creation and management interface for the Admin role.
3. **Curriculum Builder:** Build the Parent interface for assignment creation (Text/File/URL).
4. **AI Integration:** Implement the `app/lib/ai.ts` wrapper for Cloudflare Workers AI quiz generation.

## Phase 6: Functional Modules (Student & Submissions)

1. **Student Workspace:** Build the touch-optimized dashboard for students.
2. **Lesson Interaction:** Implement the video embedding and "In-Video Question" synchronized component.
3. **Submission System:** Build the assignment upload flow using Cloudflare R2 for asset storage.
4. **Progress Visualization:** Implement the initial Mastery-based progress tracking (Skill Tree) using TanStack Query.