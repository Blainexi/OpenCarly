import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod'; // add zod to deps if needed

export class RuleEngine {
  private manifest: any = null;
  private loadedRules = new Map<string, string[]>();

  async loadManifest(projectRoot: string) {
    const carlyPath = path.join(projectRoot, '.opencode/carly/manifest.json');
    try {
      const raw = await fs.readFile(carlyPath, 'utf-8');
      this.manifest = JSON.parse(raw);
      console.log(`CARLY: Loaded ${Object.keys(this.manifest.domains || {}).length} domains`);
    } catch {
      // fallback to global or create template
    }
  }

  getTriggeredDomains(prompt: string): string[] {
    const lower = prompt.toLowerCase();
    const triggered: string[] = [];
    for (const [domain, data] of Object.entries(this.manifest?.domains || {})) {
      if (data.triggers.some((t: string) => lower.includes(t))) {
        triggered.push(domain);
      }
    }
    return triggered;
  }
}