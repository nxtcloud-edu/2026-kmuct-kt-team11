import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import courseProfileJson from '../mbti-course-profile.json';
import courseDraftSchemaJson from '../course-draft.schema.json';
import transcriptExtractionJson from '../transcript-extraction.json';
import type { CourseProfile } from './types';

/**
 * JSON config is imported statically so the bundler inlines it — no fs, no
 * runtime path resolution, works in every Next.js runtime.
 *
 * The prompt template cannot be: it is markdown, and keeping it as markdown is
 * the point (see prompts/date-course-system.md). Reading it is therefore
 * cwd-relative rather than module-relative, because webpack rewrites
 * `import.meta.url` to the bundle location and would break a module-relative path.
 * Next.js runs with cwd at the project root.
 */

const SHARED_DIR = join(process.cwd(), 'packages', 'shared');

export const SYSTEM_PROMPT_PATH = join(SHARED_DIR, 'prompts', 'date-course-system.md');

export function courseProfile(): CourseProfile {
  return courseProfileJson as unknown as CourseProfile;
}

export function featureMappings(): Record<string, string[]> {
  return transcriptExtractionJson.featureMappings;
}

export function courseDraftJsonSchema(): Record<string, unknown> {
  return courseDraftSchemaJson as Record<string, unknown>;
}

let promptTemplateText: string | null = null;

/** Node runtime only. Call from a route handler or server component. */
export function readSystemPromptText(): string {
  promptTemplateText ??= readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  return promptTemplateText;
}

/** Fixtures live outside the bundle and are only read by the eval harness. */
export function readFixtureText(fixtureId: string): string {
  return readFileSync(join(SHARED_DIR, '__fixtures__', 'course-cases', `${fixtureId}.json`), 'utf8');
}
