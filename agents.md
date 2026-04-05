# Project Context: Project Orca (ProOrca)

**Vision:** An edge-native, high-performance LMS optimized for the decentralized nature of modern homeschooling.

## 🛠 Tech Stack (Non-Negotiable)

- **Framework:** TanStack Start (Router + Server Functions)
- **Styling:** Tailwind CSS + Shadcn UI (Radix UI primitives)
- **Database:** Cloudflare D1 (SQLite at the Edge)
- **ORM:** Drizzle ORM
- **Authentication:** Better Auth (Drizzle Adapter + Organizations + Impersonation)
- **Deployment:** Cloudflare Workers
- **AI:** Cloudflare Workers AI (LLAMA 3.1 70B for text; Flux for images)
- **Storage:** Cloudflare R2 (S3-Compatible)

## 🏗 Architectural Principles

1. **Edge-First:** No Node.js specific APIs. Use Web Standard APIs only.
2. **Type Safety:** Strict `zod` validation. End-to-end type safety from Drizzle to TanStack Router.
3. **Tenant Isolation:** Use "Home Pods" (Better Auth Organizations) for family-level data separation.
4. **Identity Model (Sub-accounts):** Implement a "Parent-as-Primary" model. Students do not require unique emails; they exist as member profiles within a Home Pod.
5. **Role Switching:** Use Better Auth's impersonation or custom session claims to toggle `activeRole` (Admin, Parent, Student).
6. **Server Functions:** All business logic must reside in `app/server/functions.ts`.

## 📁 Directory Structure

- `app/routes/`: TanStack Router file-based routing.
- `app/components/`: Modular UI components.
- `app/db/`: Schema definitions and D1 client.
- `app/lib/`: Better Auth, Workers AI, and R2 wrappers.
- `app/server/`: Business logic, RBAC, and server functions.

## 🚦 Feature Roadmap

- **IAM:** Primary parent account with sub-account profiles for students.
- **Profile:** Age/Grade level tracking per student profile.
- **Admin:** Class and Pod configuration.
- **Parent Center:** AI-assisted content generation and curriculum mapping.
- **Student Workspace:** Mastery-based learning and interactive video sessions.

## ⚠️ Standards & Guardrails

- **No Hardcoding:** Use Environment Variables.
- **Mobile First:** Optimized for tablets (Student primary device).
- **Performance:** Optimistic updates via TanStack Query.