import { createContext, useContext } from 'react';
import type { Project } from './api.ts';

/**
 * The project list is shared by the switcher, the `/` redirect and the project
 * shell, so mutations have to be visible to all three immediately — otherwise a
 * deleted project lingers in the dropdown and `/` can redirect straight back
 * into it.
 */
export interface ProjectsValue {
  projects: Project[];
  /** Null until the first load completes. */
  loaded: boolean;
  reload: () => Promise<void>;
  /** Adds or replaces a project without waiting for a round trip. */
  upsert: (project: Project) => void;
  remove: (projectId: string) => void;
  /**
   * Removes by slug. Kept separate from `remove` so callers do not have to
   * read `projects` to find the id — depending on the list inside a load
   * effect would re-trigger it every time the list changed.
   */
  removeBySlug: (slug: string) => void;
  /** Where to send the user once `projectId` is gone, or null if none remain. */
  nextSlugAfter: (projectId: string) => string | null;
}

export const ProjectsContext = createContext<ProjectsValue | null>(null);

export function useProjects(): ProjectsValue {
  const value = useContext(ProjectsContext);
  if (!value) throw new Error('useProjects must be used inside ProjectsContext');
  return value;
}
