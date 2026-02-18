import { definePlugin, type PluginHooks } from '@opencode-ai/plugin';
import { RuleEngine } from './ruleEngine';
import { onPreMessage } from './hooks/onPreMessage';
import { onContextPrime } from './hooks/onContextPrime';

const ruleEngine = new RuleEngine();

export default definePlugin({
  id: 'carly',
  name: 'CARLY - Context Augmentation Rules Layer',
  version: '0.1.0',
  description: 'Zero-bloat dynamic rules. Inspired by https://github.com/ChristopherKahler/carl',

  hooks: {
    onPreMessage: (msg, ctx) => onPreMessage(msg, ctx, ruleEngine),
    onContextPrime: (context, ctx) => onContextPrime(context, ctx, ruleEngine),
    // Future: onAgentInit, onSlashCommand, etc.
  } as PluginHooks,

  onInit: async (ctx) => {
    await ruleEngine.loadManifest(ctx.projectRoot || process.cwd());
    console.log('🛡️ CARLY loaded - rules ready');
  }
});