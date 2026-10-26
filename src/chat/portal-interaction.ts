import type { QuestionSchema } from "./chat-questions";

export interface PortalInteraction {
  title: string;
  detail: string;
  choices: Array<{ value: string; label: string }>;
  form?: QuestionSchema;
  secretFields?: string[];
  fieldVisibility?: Record<string, { field: string; values: string[] }>;
  verify?: (answer: Record<string, unknown>) => Promise<void>;
}

export interface PortalInteractionAnswer {
  action: string;
  fields: Record<string, unknown>;
}
