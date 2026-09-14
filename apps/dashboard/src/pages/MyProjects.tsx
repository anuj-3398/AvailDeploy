import React from 'react';
import { ProjectsView } from './Projects.tsx';

/** Same page as `/` (All Projects), scoped to just what the signed-in user created. */
export function MyProjects() {
  return <ProjectsView scope="mine" />;
}
