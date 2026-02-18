import type { Context } from '@opencode-ai/plugin';
import type { RuleEngine } from '../ruleEngine';

export async function onContextPrime(context: any, ctx: Context, engine: RuleEngine) {
  const active = ctx.getMetadata('carly:activeDomains') || [];
  if (active.length === 0) return context;

  let injection = '<carly-rules>\n';
  for (const domain of active) {
    const rules = await loadDomainRules(domain, ctx.projectRoot!);
    injection += rules + '\n';
  }
  injection += '</carly-rules>';

  // Inject as system message or skill (Opencode-native)
  context.systemMessages.push({
    role: 'system',
    content: injection
  });

  return context;
}

async function loadDomainRules(domain: string, root: string) {
  // read .opencode/carly/domains/{domain}/*.md
  return 'CARLY RULE: You are in development mode. Prefer concise diffs...';
}