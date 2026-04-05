type SeedTemplateContentType =
  | "text"
  | "file"
  | "url"
  | "video"
  | "quiz"
  | "essay_questions"
  | "report";

export type SeedAssignmentTemplate = {
  id: string;
  organizationId: null;
  title: string;
  description: string | null;
  contentType: SeedTemplateContentType;
  contentRef: string | null;
  tags: string;
  isPublic: true;
  createdByUserId: null;
};

export const seedAssignmentTemplates: SeedAssignmentTemplate[] = [
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a001",
    organizationId: null,
    title: "Introduction to Cells",
    description: "Foundational biology reading on cell structure and function.",
    contentType: "text",
    contentRef: "<h2>Introduction to Cells</h2><p>All living things are made of cells. Read the passage and explain how cell organelles work together to keep organisms alive.</p>",
    tags: JSON.stringify(["subject:science", "grade:6", "grade:7", "grade:8", "topic:cells"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a002",
    organizationId: null,
    title: "American Revolution Overview",
    description: "Survey reading of key causes and outcomes of the American Revolution.",
    contentType: "text",
    contentRef: "<h2>American Revolution Overview</h2><p>Read this overview and summarize three turning points from the Revolution. Explain why each one mattered.</p>",
    tags: JSON.stringify(["subject:history", "grade:5", "grade:6", "grade:7", "grade:8", "topic:american-revolution"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a003",
    organizationId: null,
    title: "Algebra: Order of Operations",
    description: "Practice quiz covering PEMDAS with integer expressions.",
    contentType: "quiz",
    contentRef: JSON.stringify({
      title: "Algebra: Order of Operations",
      questions: [
        { question: "Evaluate: 3 + 4 x 2", options: ["14", "11", "10", "8"], answerIndex: 1, explanation: "Multiply before adding." },
        { question: "Evaluate: (8 - 3)^2", options: ["10", "15", "25", "64"], answerIndex: 2, explanation: "Parentheses first, then exponent." },
      ],
    }),
    tags: JSON.stringify(["subject:math", "grade:6", "grade:7", "grade:8", "grade:9", "topic:order-of-operations"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a004",
    organizationId: null,
    title: "Photosynthesis Video Lesson",
    description: "Short video lesson introducing photosynthesis and energy conversion.",
    contentType: "video",
    contentRef: JSON.stringify({
      videos: [{ videoId: "UPBMG5EYydo", title: "Photosynthesis Explained" }],
    }),
    tags: JSON.stringify(["subject:science", "grade:5", "grade:6", "grade:7", "topic:photosynthesis"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a005",
    organizationId: null,
    title: "Book Report Rubric",
    description: "Structured rubric for evaluating comprehension, evidence, and writing.",
    contentType: "report",
    contentRef: "<h2>Book Report Rubric</h2><ul><li>Summary accuracy</li><li>Character analysis</li><li>Use of textual evidence</li><li>Organization and grammar</li></ul>",
    tags: JSON.stringify(["subject:language-arts", "grade:4", "grade:5", "grade:6", "grade:7", "grade:8", "topic:book-report"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a006",
    organizationId: null,
    title: "States of Matter Quiz",
    description: "Science quiz on solids, liquids, gases, and phase changes.",
    contentType: "quiz",
    contentRef: JSON.stringify({
      title: "States of Matter Quiz",
      questions: [
        { question: "Which state keeps its shape?", options: ["Liquid", "Gas", "Solid", "Plasma"], answerIndex: 2, explanation: "Solids have fixed shape and volume." },
        { question: "Evaporation changes a liquid into a:", options: ["Solid", "Gas", "Mixture", "Crystal"], answerIndex: 1, explanation: "Evaporation is liquid to gas." },
      ],
    }),
    tags: JSON.stringify(["subject:science", "grade:4", "grade:5", "grade:6", "topic:states-of-matter"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a007",
    organizationId: null,
    title: "Creative Writing Prompts",
    description: "Prompt set designed to build voice, detail, and narrative structure.",
    contentType: "essay_questions",
    contentRef: JSON.stringify({
      questions: [
        "Write about a day when gravity stopped working for one hour.",
        "Invent a new holiday and explain its traditions.",
        "Describe a character who finds a mysterious map.",
      ],
    }),
    tags: JSON.stringify(["subject:language-arts", "grade:3", "grade:4", "grade:5", "grade:6", "grade:7", "grade:8", "topic:creative-writing"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a008",
    organizationId: null,
    title: "Multiplication Tables Practice",
    description: "Fluency quiz on multiplication facts through 12.",
    contentType: "quiz",
    contentRef: JSON.stringify({
      title: "Multiplication Tables Practice",
      questions: [
        { question: "7 x 8 =", options: ["54", "56", "58", "64"], answerIndex: 1, explanation: "7 multiplied by 8 equals 56." },
        { question: "9 x 6 =", options: ["45", "48", "54", "63"], answerIndex: 2, explanation: "9 multiplied by 6 equals 54." },
      ],
    }),
    tags: JSON.stringify(["subject:math", "grade:3", "grade:4", "grade:5", "topic:multiplication"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a009",
    organizationId: null,
    title: "Civil War Reading",
    description: "Reading assignment focused on causes, battles, and outcomes of the Civil War.",
    contentType: "text",
    contentRef: "<h2>Civil War Reading</h2><p>Read the text and identify major economic and political causes of the Civil War. Include evidence from the passage.</p>",
    tags: JSON.stringify(["subject:history", "grade:7", "grade:8", "grade:9", "grade:10", "topic:civil-war"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a010",
    organizationId: null,
    title: "Grammar: Parts of Speech",
    description: "Grammar quiz on nouns, verbs, adjectives, and adverbs.",
    contentType: "quiz",
    contentRef: JSON.stringify({
      title: "Grammar: Parts of Speech",
      questions: [
        { question: "In 'The dog runs quickly', what is 'quickly'?", options: ["Noun", "Verb", "Adverb", "Adjective"], answerIndex: 2, explanation: "Adverbs describe verbs." },
        { question: "Choose the adjective:", options: ["jumped", "blue", "swiftly", "teacher"], answerIndex: 1, explanation: "Adjectives describe nouns." },
      ],
    }),
    tags: JSON.stringify(["subject:language-arts", "grade:4", "grade:5", "grade:6", "grade:7", "topic:parts-of-speech"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a011",
    organizationId: null,
    title: "Scientific Method Report",
    description: "Lab report template for hypothesis, procedure, observations, and conclusion.",
    contentType: "report",
    contentRef: "<h2>Scientific Method Report</h2><ol><li>Question</li><li>Hypothesis</li><li>Procedure</li><li>Observations</li><li>Conclusion</li></ol>",
    tags: JSON.stringify(["subject:science", "grade:5", "grade:6", "grade:7", "grade:8", "grade:9", "topic:scientific-method"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a012",
    organizationId: null,
    title: "World Geography Links",
    description: "Reference link hub for continents, climate zones, and physical geography.",
    contentType: "url",
    contentRef: "https://www.nationalgeographic.org/education/",
    tags: JSON.stringify(["subject:geography", "grade:6", "grade:7", "grade:8", "grade:9", "grade:10", "topic:world-geography"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a013",
    organizationId: null,
    title: "Fractions Video Lesson",
    description: "Video lesson covering equivalent fractions and simplification.",
    contentType: "video",
    contentRef: JSON.stringify({
      videos: [{ videoId: "L3XxC9N9Aak", title: "Fractions for Beginners" }],
    }),
    tags: JSON.stringify(["subject:math", "grade:4", "grade:5", "grade:6", "topic:fractions"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a014",
    organizationId: null,
    title: "Vocabulary Essay Questions",
    description: "Essay prompts that apply new vocabulary words in context.",
    contentType: "essay_questions",
    contentRef: JSON.stringify({
      questions: [
        "Choose five vocabulary words and use each in a meaningful paragraph.",
        "Explain how word choice changes tone in persuasive writing.",
      ],
    }),
    tags: JSON.stringify(["subject:language-arts", "grade:5", "grade:6", "grade:7", "grade:8", "grade:9", "topic:vocabulary"]),
    isPublic: true,
    createdByUserId: null,
  },
  {
    id: "0a12cb5b-2dd4-4a8f-8f8a-2da3f1c4a015",
    organizationId: null,
    title: "US Constitution Reading",
    description: "Close reading assignment focused on constitutional principles and amendments.",
    contentType: "text",
    contentRef: "<h2>US Constitution Reading</h2><p>Read the selected section and explain how it limits government power. Cite two examples.</p>",
    tags: JSON.stringify(["subject:history", "grade:8", "grade:9", "grade:10", "grade:11", "grade:12", "topic:us-constitution"]),
    isPublic: true,
    createdByUserId: null,
  },
];
