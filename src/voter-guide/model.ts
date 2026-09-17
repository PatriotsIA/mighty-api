import source from "./questions.json";

// Mirrored in pia-counties/src/voter-guide. Keep this version immutable so saved
// answers continue to refer to the exact questions the candidate received.
export const legacyVoterGuideVersion = "texas-republican-2026-09";
export const voterGuideVersion = "localized-republican-2026-09";
export const answerCharacterLimit = 4_000;
export type Question = {
  number: number;
  section: string;
  type: "text" | "yes_no_explain" | "primary_history" | "checkbox_explain" | "yes_no_explain_amounts";
  label: string;
  text: string;
  note?: string;
  years?: number[];
  options?: string[];
  shortLimit?: number;
  amountFields?: string[];
  fundSource?: string[];
};
export type Office = { order: number; id: string; office: string; level: string; judicial: boolean; questions: Question[] };
export const voterGuide = source as { wordLimit: number; shortAnswerWordLimit: number; offices: Office[] };
export type VoterGuideAnswer = {
  text?: string;
  choice?: "Yes" | "No";
  history?: Record<string, string>;
  selections?: string[];
  amounts?: Record<string, string>;
  fundSource?: string;
};
export type VoterGuideResponse = { version: typeof voterGuideVersion | typeof legacyVoterGuideVersion; officeId: string; answers: Record<string, VoterGuideAnswer> };
export type VoterGuideIssue = { path: (string | number)[]; message: string };

export const questionnaireSections = [
  { id: "office", title: "About the office", note: "Ten questions about the office you seek." },
  { id: "election_transparency", title: "Election transparency", note: "Asked of every candidate in every race." },
  { id: "party_affiliation_and_support", title: "Party affiliation and support", note: "Asked of every candidate in every race. Your answers in this section do not affect whether or how you are included in the voter guide." },
];
export const judicialNote = "Note to judicial candidates: These questions are written to respect the Texas Code of Judicial Conduct. They do not ask you to comment on pending or impending cases or to pledge how you would rule on any matter. The election transparency questions ask about election policy and your own race, not about how you would decide any case.";
export function wordCount(text: string) { return text.trim() ? text.trim().split(/\s+/u).length : 0; }
export function answerWordLimit(question: Question) { return question.shortLimit ?? voterGuide.wordLimit; }
export function questionnaireOffice(id: string) { return voterGuide.offices.find((office) => office.id === id); }

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Responses are optional. Validate only supplied answers, preserving blanks
// without inventing a candidate position or response.
export function voterGuideIssues(value: unknown): VoterGuideIssue[] {
  const issues: VoterGuideIssue[] = [];
  const issue = (path: (string | number)[], message: string) => { issues.push({ path, message }); };
  if (!object(value)) return [{ path: [], message: "Choose a valid voter guide questionnaire." }];
  for (const key of Object.keys(value)) if (!["version", "officeId", "answers"].includes(key)) issue([key], "Unknown questionnaire field.");
  if (value.version !== voterGuideVersion && value.version !== legacyVoterGuideVersion) issue(["version"], "Unsupported questionnaire version.");
  const office = typeof value.officeId === "string" ? questionnaireOffice(value.officeId) : undefined;
  if (!office) issue(["officeId"], "Choose a supported office questionnaire.");
  if (!object(value.answers)) { issue(["answers"], "Answers must be an object."); return issues; }
  if (!office) return issues;
  for (const key of Object.keys(value.answers)) if (!office.questions.some((q) => String(q.number) === key)) issue(["answers", key], "Unknown question number.");
  for (const question of office.questions) {
    const key = String(question.number);
    const path = ["answers", key];
    const answer = value.answers[key];
    if (answer === undefined) continue;
    if (!object(answer)) { issue(path, "Answer must be an object."); continue; }
    const allowed = question.type === "primary_history" ? ["history"]
      : question.type === "checkbox_explain" ? ["selections", "text"]
      : question.type === "yes_no_explain_amounts" ? ["choice", "text", "amounts", ...(question.fundSource ? ["fundSource"] : [])]
      : question.type === "yes_no_explain" ? ["choice", "text"] : ["text"];
    for (const field of Object.keys(answer)) if (!allowed.includes(field)) issue([...path, field], "This field does not belong to this question.");
    if (answer.text !== undefined && (typeof answer.text !== "string" || answer.text.length > answerCharacterLimit || wordCount(answer.text) > answerWordLimit(question))) {
      issue([...path, "text"], `Use at most ${answerWordLimit(question)} words and ${answerCharacterLimit} characters.`);
    }
    if (allowed.includes("choice") && answer.choice !== undefined && (typeof answer.choice !== "string" || !["Yes", "No"].includes(answer.choice))) issue([...path, "choice"], "Choose Yes or No.");
    if (allowed.includes("history")) {
      if (answer.history !== undefined && !object(answer.history)) issue([...path, "history"], "Choose a primary for each year.");
      const history = object(answer.history) ? answer.history : {};
      for (const year of Object.keys(history)) if (!question.years?.map(String).includes(year)) issue([...path, "history", year], "Unknown primary year.");
      for (const year of question.years || []) if (history[year] !== undefined && (typeof history[year] !== "string" || !question.options?.includes(history[year] as string))) issue([...path, "history", year], "Choose Republican, Democratic, or Did not vote.");
    }
    if (allowed.includes("selections")) {
      if (answer.selections !== undefined && (!Array.isArray(answer.selections) || answer.selections.some((v) => typeof v !== "string" || !question.options?.includes(v)) || new Set(answer.selections).size !== answer.selections.length)) issue([...path, "selections"], "Choose each listed activity at most once.");
      if (Array.isArray(answer.selections) && answer.selections.includes("None of the above") && answer.selections.length > 1) issue([...path, "selections"], "Choose None of the above on its own.");
    }
    if (allowed.includes("amounts")) {
      if (answer.amounts !== undefined && !object(answer.amounts)) issue([...path, "amounts"], "Enter contribution amounts in dollars.");
      const amounts = object(answer.amounts) ? answer.amounts : {};
      for (const field of Object.keys(amounts)) if (!question.amountFields?.includes(field)) issue([...path, "amounts", field], "Unknown contribution field.");
      for (const field of question.amountFields || []) {
        const amount = amounts[field];
        if (amount !== undefined && (typeof amount !== "string" || !/^\d{1,10}(\.\d{1,2})?$/.test(amount))) issue([...path, "amounts", field], "Enter a nonnegative dollar amount with at most two decimal places (0 is allowed).");
      }
      if (answer.fundSource !== undefined && (typeof answer.fundSource !== "string" || !question.fundSource?.includes(answer.fundSource))) issue([...path, "fundSource"], "Choose a listed source of funds.");
    }
  }
  return issues;
}

export function isVoterGuideResponse(value: unknown): value is VoterGuideResponse { return voterGuideIssues(value).length === 0; }

// A readable representation is also used by the review comparison. Never render
// stored answer objects as [object Object] or omit a zero-dollar response.
export function answerLines(question: Question, answer?: VoterGuideAnswer): string[] {
  if (!answer) return [];
  return [
    ...(answer.choice ? [answer.choice] : []),
    ...(answer.text?.trim() ? [answer.text] : []),
    ...(question.years || []).flatMap((year) => answer.history?.[year] ? [`${year}: ${answer.history[year]}`] : []),
    ...(question.options || []).filter((option) => answer.selections?.includes(option)),
    ...(question.amountFields || []).flatMap((field) => answer.amounts?.[field] !== undefined ? [`${field}: $${answer.amounts[field]}`] : []),
    ...(answer.fundSource ? [`Source of funds: ${answer.fundSource}`] : []),
  ];
}
