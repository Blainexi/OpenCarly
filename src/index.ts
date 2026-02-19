// .opencode/plugins/opencarly/index.ts
import fs from 'node:fs/promises';
import path from 'node:path';

class OpenCarlyPlugin {
  name = 'opencarly';
  version = '0.4.0';
  manifest: any = null;
  activeDomains: string[] = [];
  strictMode = false;
  briefMode = false;

  async init(projectRoot: string) {
    await this.loadManifest(projectRoot);
  }

  private async loadManifest(projectRoot: string) { /* same as v0.3 - unchanged */ }
  private async exists(p: string) { /* same */ }
  private async createDefaultStructure(carlyDir: string) { /* updated below */ }
  private async loadDomainRules(domain: string, root: string): Promise<string> { /* same as v0.3 */ }

  async onPreMessage(event: any) {
    let prompt = '';
    const msg = event.message || event;
    if (typeof msg.content === 'string') prompt = msg.content;
    else if (Array.isArray(msg.content)) prompt = msg.content.map((c: any) => typeof c === 'string' ? c : '').join(' ');

    const lower = prompt.toLowerCase().trim();

    // Star commands
    if (lower.includes('*brief')) this.briefMode = true;
    if (lower.includes('*full')) { this.briefMode = false; this.strictMode = false; }
    if (lower.includes('*strict') || lower.includes('*diffonly')) this.strictMode = true;
    if (lower.includes('*carl')) console.log(`[OpenCarly] 📋 Active domains: ${this.activeDomains.join(', ') || 'none'} | Brief: ${this.briefMode} | Strict: ${this.strictMode}`);

    this.activeDomains = [];
    for (const [domain, data] of Object.entries(this.manifest?.domains || {})) {
      const triggers = (data as any).triggers || [];
      if (triggers.some((t: string) => lower.includes(t.toLowerCase()))) {
        this.activeDomains.push(domain);
        console.log(`[OpenCarly] 🔥 Activated: ${domain}`);
      }
    }
  }

  async onContextPrime(request: any) {
    const root = request.projectRoot || process.cwd();
    let injection = `\n\n=== CARLY EFFICIENCY (ALWAYS) ===\nCode over explanation. Show, don't tell. NEVER repeat unchanged code. Target <250 tokens per reply.`;

    if (this.strictMode) injection += `\n\n=== STRICT DIFF-ONLY MODE ===\nALWAYS respond with unified diff only. No explanations unless *explain. No pleasantries.`;
    if (this.briefMode) injection += `\n\n=== BRIEF MODE ===\nUltra-concise. One-line answers when possible.`;

    for (const domain of this.activeDomains) {
      const rules = await this.loadDomainRules(domain, root);
      if (rules) injection += `\n\n=== CARLY DOMAIN: ${domain.toUpperCase()} ===\n${rules}`;
    }

    console.log(`[OpenCarly] 📉 Injecting ~${Math.round(injection.length/4)} tokens (efficiency + ${this.activeDomains.length} domains)`);
    return { context: injection };
  }

  async onPostMessage(event: any) {
    const msg = event.message || event;
    if (msg.role !== 'assistant' || typeof msg.content !== 'string') return;

    const outTokens = Math.round(msg.content.length / 4);
    console.log(`[OpenCarly] 📊 OUTPUT TOKENS THIS TURN: ~${outTokens} | Strict mode: ${this.strictMode}`);

    // Structural enforcement
    if (this.strictMode && (msg.content.length > 700 || /here is|explanation|let me|as you can see/i.test(msg.content))) {
      console.log(`[OpenCarly] ⚠️ Verbose detected → forcing stricter rules next turn`);
      this.strictMode = true; // stay in enforcement
    }
  }
}

export default OpenCarlyPlugin;