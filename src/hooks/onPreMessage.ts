TypeScriptimport type { Message, Context } from '@opencode-ai/plugin';
import type { RuleEngine } from '../ruleEngine';

export async function onPreMessage(
  msg: Message,
  ctx: Context,
  engine: RuleEngine
) {
  const prompt = typeof msg.content === 'string' ? msg.content : '';
  const domains = engine.getTriggeredDomains(prompt);

  if (domains.length > 0 || prompt.includes('*carly')) {
    ctx.setMetadata('carly:activeDomains', domains);
    // Star commands handled here too
    if (prompt.startsWith('*brief')) {
      ctx.setMetadata('carly:mode', 'brief');
    }
  }
  return msg; // pass through (or modify)
}