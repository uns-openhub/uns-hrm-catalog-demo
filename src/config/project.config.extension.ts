import { z } from 'zod';

// Extend this schema with project-specific configuration sections.
export const projectExtrasSchema = z.object({});

export type ProjectExtras = z.infer<typeof projectExtrasSchema>;
