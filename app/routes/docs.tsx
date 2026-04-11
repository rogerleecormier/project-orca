import { useEffect, useState, useRef, ReactNode } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";
import { OrcaMark } from "../components/icons/orca-mark";

export const Route = createFileRoute("/docs")({
  component: DocsPage,
});

const DOC_SECTIONS = [
  {
    id: "overview",
    title: "Overview",
    content: (
      <div className="space-y-4 text-slate-600 leading-relaxed">
        <p>
          Welcome to the ProOrca documentation. ProOrca is an edge-native homeschool command center built for parents who want intelligent lesson planning, gamified skill progression, and everything in one place.
        </p>
        <p>
          Navigate through the sections on the left to learn how to use the various features, from setting up your curriculum with AI to tracking student progress and delivering rewards.
        </p>
      </div>
    )
  },
  {
    id: "ai-curriculum-builder",
    title: "AI Curriculum Builder",
    content: (
      <div className="space-y-4">
        <h3 className="text-xl font-semibold text-slate-800">How it works</h3>
        <p className="text-slate-600 leading-relaxed">
          The AI Curriculum Builder allows you to launch a full multi-course curriculum or a single course flow. The AI generates the spine, branches, layout, and assignments in the background.
        </p>
        <h4 className="font-semibold text-slate-800 pt-2">Steps to build:</h4>
        <ol className="list-decimal pl-5 space-y-2 text-slate-600">
          <li>Navigate to the Curriculum Builder from the parent dashboard.</li>
          <li>Select the grade level, subjects, and desired duration.</li>
          <li>Add any custom preferences or focus areas (e.g., "focus on ancient history").</li>
          <li>Click "Generate Curriculum" and wait for the AI to draft the structure.</li>
          <li>Review the generated courses, make any edits, and save to your workspace.</li>
        </ol>
      </div>
    )
  },
  {
    id: "skill-maps",
    title: "Skill Maps & Builder Mode",
    content: (
      <div className="space-y-4">
        <h3 className="text-xl font-semibold text-slate-800">Visual Progression</h3>
        <p className="text-slate-600 leading-relaxed">
          Build node-based learning paths with lesson, milestone, boss, branch, and elective nodes. Both parents and students interact with the same map, but parents have additional builder controls.
        </p>
        <h4 className="font-semibold text-slate-800 pt-2">Steps to use Builder Mode:</h4>
        <ol className="list-decimal pl-5 space-y-2 text-slate-600">
          <li>Go to the "Skill Trees" section and open a specific map.</li>
          <li>Press <kbd className="bg-slate-100 border border-slate-300 rounded px-1 text-xs">N</kbd> to add a new node or drag from an existing node to connect dependencies.</li>
          <li>Click a node and press <kbd className="bg-slate-100 border border-slate-300 rounded px-1 text-xs">E</kbd> to edit its content (title, XP, type).</li>
          <li>Assign tasks directly to the node so that when a student completes them, the node status updates automatically.</li>
        </ol>
      </div>
    )
  },
  {
    id: "assignment-studio",
    title: "Assignment Studio",
    content: (
      <div className="space-y-4">
        <h3 className="text-xl font-semibold text-slate-800">Creating Content</h3>
        <p className="text-slate-600 leading-relaxed">
          Create text, file, URL, video, quiz, essay, report, and movie assignments. You can even generate linked quizzes from readings or saved video transcripts.
        </p>
        <h4 className="font-semibold text-slate-800 pt-2">Steps to create an assignment:</h4>
        <ol className="list-decimal pl-5 space-y-2 text-slate-600">
          <li>Open "Assignments" or the specific class folder.</li>
          <li>Click "New Assignment" and select the assignment type.</li>
          <li>Fill in the details, attach any required materials, and set point values.</li>
          <li>If it's a quiz, you can use the AI assistant to generate questions based on the provided material.</li>
          <li>Save the assignment or save it as a Template for future reuse.</li>
        </ol>
      </div>
    )
  },
  {
    id: "week-planner",
    title: "Week Planner",
    content: (
      <div className="space-y-4">
        <h3 className="text-xl font-semibold text-slate-800">Scheduling the Week</h3>
        <p className="text-slate-600 leading-relaxed">
          Schedule with drag-and-drop across a 4–7 day week. Pull from recommended skill-map assignments or the pending pool, then save or auto-generate a full week plan.
        </p>
        <h4 className="font-semibold text-slate-800 pt-2">Steps to plan your week:</h4>
        <ol className="list-decimal pl-5 space-y-2 text-slate-600">
          <li>Navigate to the "Planner" tab.</li>
          <li>Review the "All Assignments Pool" on the right sidebar.</li>
          <li>Drag and drop assignments into specific days of the week.</li>
          <li>Alternatively, click "Auto-Plan Week" to let the AI suggest a balanced schedule based on pending work.</li>
          <li>Click "Save Plan" to finalize the schedule for the student workspace.</li>
        </ol>
      </div>
    )
  },
  {
    id: "gradebook",
    title: "Gradebook & Release Flow",
    content: (
      <div className="space-y-4">
        <h3 className="text-xl font-semibold text-slate-800">Evaluating Work</h3>
        <p className="text-slate-600 leading-relaxed">
          Filter and sort submissions, export CSV, auto-score quizzes, use AI scoring for written work, and release graded results back to students.
        </p>
        <h4 className="font-semibold text-slate-800 pt-2">Steps to grade:</h4>
        <ol className="list-decimal pl-5 space-y-2 text-slate-600">
          <li>Open the "Gradebook" to view all pending submissions.</li>
          <li>Select an assignment to review the student's work.</li>
          <li>For quizzes, scores are auto-calculated but can be manually overridden.</li>
          <li>For essays or written work, click "AI Assist" for scoring suggestions and constructive feedback.</li>
          <li>Once finalized, click "Release Grade" to make it visible to the student and award XP.</li>
        </ol>
      </div>
    )
  },
  {
    id: "reward-tracks",
    title: "Orca Currents",
    content: (
      <div className="space-y-4">
        <h3 className="text-xl font-semibold text-slate-800">Gamifying Progress</h3>
        <p className="text-slate-600 leading-relaxed">
          Track XP snapshots from skill-map progress and auto-unlock claimable tiers. Students claim rewards, parents deliver them, and pending claims stay visible in-app.
        </p>
        <h4 className="font-semibold text-slate-800 pt-2">Steps to manage rewards:</h4>
        <ol className="list-decimal pl-5 space-y-2 text-slate-600">
          <li>Navigate to "Rewards" in the parent dashboard.</li>
          <li>Create a new Orca Current and define tiers (e.g., Tier 1 at 500 XP, Tier 2 at 1000 XP).</li>
          <li>Assign real-world or digital rewards to each tier.</li>
          <li>When a student reaches an XP threshold, they click "Claim" in their dashboard.</li>
          <li>Review the pending claim in your dashboard and click "Mark as Delivered" once you have fulfilled the reward.</li>
        </ol>
      </div>
    )
  },
  {
    id: "home-pod",
    title: "Home Pod & Role Switching",
    content: (
      <div className="space-y-4">
        <h3 className="text-xl font-semibold text-slate-800">Managing the Family</h3>
        <p className="text-slate-600 leading-relaxed">
          Support multi-family organizations with parent admin controls, plus quick parent/student workspace switching with profile selection and PIN confirmation.
        </p>
        <h4 className="font-semibold text-slate-800 pt-2">Steps to switch roles:</h4>
        <ol className="list-decimal pl-5 space-y-2 text-slate-600">
          <li>Click the Profile icon in the top right corner.</li>
          <li>Select "Switch Profile" or use the top-right menu to switch directly if logged in.</li>
          <li>Choose the student or parent profile you wish to log into.</li>
          <li>Enter the corresponding PIN (e.g., parent PIN for admin access, student PIN for their workspace).</li>
        </ol>
      </div>
    )
  }
];

function LazySection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          // Optional: We can disconnect if we only want it to animate once.
          // observer.disconnect();
        } else {
          // If we want it to animate every time it scrolls into view, we can toggle it off when not intersecting.
          // For documentation, we usually just animate in once.
        }
      },
      { rootMargin: "0px 0px -100px 0px", threshold: 0.1 }
    );

    if (sectionRef.current) {
      observer.observe(sectionRef.current);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <section
      id={id}
      ref={sectionRef}
      className={`pt-24 pb-12 border-b border-slate-200 transition-all duration-700 ease-out scroll-mt-16 ${
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
      }`}
    >
      <h2 className="text-3xl font-bold tracking-tight text-slate-900 mb-6">{title}</h2>
      <div className="prose prose-slate max-w-none">
        {isVisible ? children : <div className="h-48 animate-pulse bg-slate-50 rounded-xl" />}
      </div>
    </section>
  );
}

function DocsPage() {
  const [activeSection, setActiveSection] = useState(DOC_SECTIONS[0].id);

  useEffect(() => {
    const handleScroll = () => {
      const sectionElements = DOC_SECTIONS.map(s => document.getElementById(s.id));
      let currentActive = activeSection;
      
      for (const el of sectionElements) {
        if (el) {
          const rect = el.getBoundingClientRect();
          // Check if the top of the section is near the top of the viewport
          if (rect.top <= 200 && rect.bottom >= 200) {
            currentActive = el.id;
          }
        }
      }
      if (currentActive !== activeSection) {
        setActiveSection(currentActive);
      }
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    // Trigger once on mount
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, [activeSection]);

  const scrollToSection = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    setActiveSection(id);
  };

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <Link to="/" className="flex items-center gap-2 hover:opacity-80 transition">
              <span className="orca-icon-chip" aria-hidden="true">
                <OrcaMark className="h-6 w-6" alt="" />
              </span>
              <span className="text-lg font-semibold text-slate-900">ProOrca</span>
            </Link>
            <span className="ml-2 border-l border-slate-300 pl-4 text-sm font-medium text-slate-500">
              Documentation
            </span>
          </div>
          <div>
            <Link
              to="/"
              className="text-sm font-medium text-slate-600 hover:text-slate-900 transition"
            >
              Back to Home
            </Link>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl items-start pt-16">
        {/* Sidebar Nav */}
        <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-64 shrink-0 overflow-y-auto border-r border-slate-200 py-8 pr-6 lg:block">
          <nav className="space-y-1">
            <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-500 px-3">
              Contents
            </p>
            {DOC_SECTIONS.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                onClick={(e) => scrollToSection(e, section.id)}
                className={`block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  activeSection === section.id
                    ? "bg-cyan-50 text-cyan-700"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                {section.title}
              </a>
            ))}
          </nav>
        </aside>

        {/* Main Content */}
        <main className="min-w-0 flex-1 px-4 py-8 sm:px-6 lg:pl-12 lg:pr-8">
          <div className="max-w-3xl">
            <div className="mb-8">
              <p className="text-sm font-semibold uppercase tracking-[0.25em] text-cyan-700">
                Documentation
              </p>
              <h1 className="mt-2 text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
                ProOrca User Guide
              </h1>
              <p className="mt-4 text-lg text-slate-600">
                Learn how to set up, build, and manage your homeschool environment using ProOrca's powerful tools.
              </p>
            </div>

            <div className="space-y-4 pb-32">
              {DOC_SECTIONS.map((section) => (
                <LazySection key={section.id} id={section.id} title={section.title}>
                  {section.content}
                </LazySection>
              ))}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
