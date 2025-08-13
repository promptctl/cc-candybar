import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { debug } from "./logger";

export function getClaudePaths(): string[] {
  const paths: string[] = [];
  
  const homeDir = homedir();
  const defaultPath = join(homeDir, ".claude");
  
  if (existsSync(defaultPath)) {
    paths.push(defaultPath);
  }
  
  return paths;
}

export async function findProjectPaths(claudePaths: string[]): Promise<string[]> {
  const projectPaths: string[] = [];
  
  for (const claudePath of claudePaths) {
    const projectsDir = join(claudePath, "projects");
    
    if (existsSync(projectsDir)) {
      try {
        const entries = await readdir(projectsDir, { withFileTypes: true });
        
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const projectPath = join(projectsDir, entry.name);
            projectPaths.push(projectPath);
          }
        }
      } catch (error) {
        debug(`Failed to read projects directory ${projectsDir}:`, error);
      }
    }
  }
  
  return projectPaths;
}

export async function findTranscriptFile(sessionId: string): Promise<string | null> {
  const claudePaths = getClaudePaths();
  const projectPaths = await findProjectPaths(claudePaths);
  
  for (const projectPath of projectPaths) {
    const transcriptPath = join(projectPath, `${sessionId}.jsonl`);
    if (existsSync(transcriptPath)) {
      return transcriptPath;
    }
  }
  
  return null;
}