export const starterPromptCategories = [
  'retrieval-print',
  'visit-preparation',
  'longitudinal',
  'cross-specialty',
] as const;

export type StarterPromptCategory = (typeof starterPromptCategories)[number];

export type StarterPrompt = {
  category: StarterPromptCategory;
  label: string;
  message: string;
};

const prompt = (category: StarterPromptCategory, question: string): StarterPrompt => ({
  category,
  label: question,
  message: question,
});

export const starterPromptPool: readonly StarterPrompt[] = [
  prompt('retrieval-print', 'Where is my most recent lab report, and what does it say?'),
  prompt('retrieval-print', 'What values are recorded in my latest eyeglass prescription?'),
  prompt('retrieval-print', 'Where is my latest dental chart, and what findings does it record?'),
  prompt('retrieval-print', 'What is the latest medication record in my archive?'),
  prompt('retrieval-print', 'Can you draft a source-linked summary for a new doctor?'),
  prompt('retrieval-print', 'Can you draft a dated timeline with links to the original records?'),
  prompt('retrieval-print', 'Can you draft a printable note from my saved lab results?'),
  prompt('retrieval-print', 'Can you help me find the original document for a saved record?'),

  prompt('visit-preparation', 'What record-backed questions could I bring to my annual checkup?'),
  prompt('visit-preparation', 'Can you help me prepare for a dental visit from my saved records?'),
  prompt('visit-preparation', 'Can you help me prepare for a vision appointment from my records?'),
  prompt(
    'visit-preparation',
    'Can you organize my saved concerns into an editable urgent care note?',
  ),
  prompt('visit-preparation', 'Can you draft an editable agenda for my next visit?'),
  prompt('visit-preparation', 'What medication questions could I ask at my next visit?'),
  prompt(
    'visit-preparation',
    'Which recent documented concerns might I discuss with my clinician?',
  ),
  prompt('visit-preparation', 'Can you draft a source-linked handoff summary for a provider?'),

  prompt('longitudinal', 'How have my recorded B12 results changed over time?'),
  prompt(
    'longitudinal',
    'What changes appear in my available lab records from the past five years?',
  ),
  prompt('longitudinal', 'How do my saved blood pressure readings compare over time?'),
  prompt('longitudinal', 'How have my recorded cholesterol results changed over time?'),
  prompt('longitudinal', 'What medication changes are documented across my records and notes?'),
  prompt('longitudinal', 'What changes are documented across my vision records?'),
  prompt('longitudinal', 'How do my dated dental measurements compare?'),
  prompt('longitudinal', 'Can you build an editable timeline of documented health events?'),

  prompt('cross-specialty', 'Do my dental and lab records contain any documented overlaps?'),
  prompt(
    'cross-specialty',
    'What timing or concerns are recorded across my eye and medication records?',
  ),
  prompt(
    'cross-specialty',
    'Which concerns are documented across visits with different specialties?',
  ),
  prompt(
    'cross-specialty',
    'What documented overlaps appear in my dental and primary care records?',
  ),
  prompt(
    'cross-specialty',
    'Do my vision and primary care records repeat any documented concerns?',
  ),
  prompt('cross-specialty', 'Do my records document medication side effects or related concerns?'),
  prompt('cross-specialty', 'Which findings or timing repeat across my specialty records?'),
  prompt('cross-specialty', 'What source-backed questions could I ask across my specialties?'),
];

export function sampleStarterPrompts(
  random: () => number = Math.random,
  previous: readonly StarterPrompt[] = [],
): StarterPrompt[] {
  const previousLabels = new Set(previous.map((item) => item.label));
  const sampled = starterPromptCategories.map((category) => {
    const categoryPrompts = starterPromptPool.filter((item) => item.category === category);
    const freshPrompts = categoryPrompts.filter((item) => !previousLabels.has(item.label));
    const choices = freshPrompts.length ? freshPrompts : categoryPrompts;
    const index = Math.min(choices.length - 1, Math.floor(random() * choices.length));
    return choices[Math.max(0, index)];
  });

  for (let index = sampled.length - 1; index > 0; index--) {
    const swapIndex = Math.min(index, Math.floor(random() * (index + 1)));
    [sampled[index], sampled[swapIndex]] = [sampled[swapIndex], sampled[index]];
  }
  return sampled;
}
