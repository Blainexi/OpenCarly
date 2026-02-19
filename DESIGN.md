# OpenCarly Design Document

> **Purpose**: Complete reference for building OpenCarly. If chat context is lost, read this file to resume.
> **Last updated**: Phase 9 - Build passes, all source files implemented

---

## What Is OpenCarly

A plugin for [OpenCode](https://github.com/anomalyco/opencode) that replicates [CARL](https://github.com/ChristopherKahler/carl) (Context Augmentation & Reinforcement Layer for Claude Code).

**Core idea**: Instead of loading all instructions statically in AGENTS.md, inject rules **just-in-time** based on what the user is doing. Rules load when relevant keywords appear in the user's prompt and disappear when not needed.

## CARL Features We're Replicating

| Feature | Description |
|---------|-------------|
| **Domain system** | Named rule collections (GLOBAL, DEVELOPMENT, TESTING, etc.) triggered by keywords |
| **Star-commands** | Explicit `*commandname` triggers (`*brief`, `*dev`, `*plan`, etc.) |
| **Context brackets** | Adjust behavior based on session age (FRESH/MODERATE/DEPLETED/CRITICAL) |
| **Session management** | Per-session state tracking with override support |
| **DEVMODE** | Debug output showing which domains/rules were loaded |
| **Exclusion system** | Global and per-domain exclusions to prevent rule loading |
| **Installer** | CLI tool to set up config and register plugin |
| **Management command** | `/carly` command for toggling domains, creating rules, etc. |

## Key Architectural Decisions

### CARL vs OpenCarly Mapping

| CARL (Claude Code) | OpenCarly (OpenCode) |
|---------------------|----------------------|
| Python hook on `UserPromptSubmit` | TypeScript plugin with `chat.message` + `experimental.chat.system.transform` hooks |
| `additionalContext` JSON output | System prompt injection via `output.system.push()` |
| `.carl/` with KEY=VALUE flat files | `.opencarly/` with JSON config + Markdown rule files |
| `CLAUDE.md` integration block | `AGENTS.md` integration block |
| `settings.json` hook registration | `opencode.json` plugin array |
| `/carl:manager` slash command | `/carly` custom command |
| Python `re.search()` keyword matching | TypeScript regex keyword matching |

### Config Format: JSON + Markdown

- **`manifest.json`** - Central config (domain registry, settings)
- **`commands.json`** - Star-command definitions
- **`context.json`** - Context bracket thresholds and rules
- **`domains/*.md`** - Rule files as Markdown, rules are bullet points (`- rule text`)
- **`sessions/*.json`** - Auto-generated per-session state

### Context Tracking: Prompt Counter Heuristic

CARL reads Claude's internal JSONL transcript for token usage. OpenCode doesn't expose this. We use prompt count per session instead:

| Bracket | Prompt Range (default) | Purpose |
|---------|----------------------|---------|
| FRESH | 1-15 | Lean injection, trust recent context |
| MODERATE | 16-35 | Standard reinforcement |
| DEPLETED | 36-50 | Heavy reinforcement, checkpoint progress |
| CRITICAL | 51+ | Warning to compact or spawn fresh session |

Thresholds configurable in `context.json`.

### Hook Strategy

Two hooks work together on every user message:

1. **`chat.message`** - Fires first. Reads the user's prompt text. Runs keyword matcher and star-command detection. Stores results + bumps session prompt count.
2. **`experimental.chat.system.transform`** - Fires when building the system prompt. Uses cached match results to load rules, format them, and push into `output.system[]`.

Additional:
- **`event`** - Listen for `session.created` to initialize session tracking and clean stale sessions.

## File Structure

```
opencarly/
├── DESIGN.md                          # This file
├── package.json
├── tsconfig.json
├── .gitignore
├── src/
│   ├── index.ts                       # Plugin entry point
│   ├── config/
│   │   ├── index.ts                   # Barrel exports
│   │   ├── schema.ts                  # Zod schemas for all config files
│   │   ├── discovery.ts               # Find .opencarly/ directory
│   │   └── manifest.ts                # Parse + validate config files
│   ├── engine/
│   │   ├── index.ts                   # Barrel exports
│   │   ├── matcher.ts                 # Domain keyword matching + star-commands
│   │   ├── loader.ts                  # Load rules from .md files
│   │   └── brackets.ts               # Context bracket resolution
│   ├── session/
│   │   └── session.ts                 # Session CRUD, overrides, stale cleanup
│   └── formatter/
│       └── formatter.ts               # Format rules into injectable text
├── templates/
│   └── .opencarly/
│       ├── manifest.json
│       ├── commands.json
│       ├── context.json
│       └── domains/
│           ├── global.md
│           ├── development.md
│           ├── testing.md
│           └── security.md
├── bin/
│   └── install.js                     # CLI installer (npx opencarly)
└── commands/
    └── carly-manager.md               # /carly custom command
```

## Schema Reference

### manifest.json

```json
{
  "version": 1,
  "devmode": false,
  "globalExclude": ["casual", "chat"],
  "domains": {
    "global": {
      "state": "active",
      "alwaysOn": true,
      "file": "domains/global.md"
    },
    "development": {
      "state": "active",
      "alwaysOn": false,
      "recall": ["fix", "bug", "implement", "refactor", "write code", "function", "class", "component"],
      "exclude": [],
      "file": "domains/development.md"
    }
  }
}
```

Fields per domain:
- `state`: `"active"` | `"inactive"`
- `alwaysOn`: boolean - load every prompt regardless of keywords
- `recall`: string[] - keywords that trigger this domain (substring match, case-insensitive)
- `exclude`: string[] - keywords that prevent this domain from loading
- `file`: string - path to rule file relative to `.opencarly/`

### commands.json

```json
{
  "brief": {
    "description": "Concise responses only",
    "rules": ["Bullet points only, max 5 items", "No preamble or summary"]
  },
  "dev": {
    "description": "Development mode",
    "rules": ["Code over explanation - show, don't tell", "Prefer diffs for changes"]
  }
}
```

### context.json

```json
{
  "thresholds": { "moderate": 15, "depleted": 35, "critical": 50 },
  "brackets": {
    "fresh": {
      "enabled": true,
      "rules": ["Context mode: LEAN - minimal injection", "Trust recent context"]
    },
    "moderate": {
      "enabled": true,
      "rules": ["Context mode: STANDARD - reinforcing key context", "Re-state current goals"]
    },
    "depleted": {
      "enabled": true,
      "rules": ["Context mode: REINFORCEMENT - heavy injection", "Summarize progress before continuing"]
    }
  }
}
```

### Domain rule files (domains/*.md)

```markdown
# Development Rules

- Code over explanation - show, don't tell
- Prefer editing existing files over creating new ones
- Use absolute paths in all file references
```

Parser: read file, extract lines starting with `- ` (after trimming). Lines starting with `#` are headings (ignored as rules). Empty lines ignored.

### Session files (sessions/*.json)

```json
{
  "id": "session-uuid",
  "started": "2026-02-19T...",
  "cwd": "/path/to/project",
  "label": "project-name",
  "title": null,
  "promptCount": 0,
  "lastActivity": "2026-02-19T...",
  "overrides": {
    "devmode": null,
    "domainStates": {}
  }
}
```

## Formatter Output

Rules injected into system prompt wrapped in XML tags:

```xml
<carly-rules>
CONTEXT BRACKET: [FRESH] (prompt 3/15)

[FRESH] CONTEXT RULES:
  1. Context mode: LEAN - minimal injection
  2. Trust recent context

DEVMODE: off

LOADED DOMAINS:
  [GLOBAL] always_on (5 rules)
  [DEVELOPMENT] matched: "fix bug" (4 rules)

[GLOBAL] RULES:
  1. Use absolute paths in all file references
  2. Prefer editing existing files over creating new

[DEVELOPMENT] RULES:
  1. Code over explanation - show, don't tell
  2. Prefer diffs for changes

AVAILABLE (not loaded):
  TESTING (recall: test, testing, TDD, coverage)
  SECURITY (recall: auth, password, token, secret)
</carly-rules>
```

When star-commands are active, they appear prominently after bracket rules.

When DEVMODE=true, an instruction is added requiring the AI to append a debug block.

## Engine Logic

### Matching Algorithm (matcher.ts)

```
1. Lowercase the user prompt
2. Check globalExclude keywords - if ANY match, skip all domain matching
3. For each active, non-alwaysOn domain:
   a. Check domain exclude keywords - if any match, mark excluded, skip
   b. Check domain recall keywords - if any match (substring, case-insensitive), mark matched
4. Scan for *commandname patterns via regex /\*([a-zA-Z]\w*)/g
5. Return: { matched, excluded, globalExcluded, starCommands }
```

### Rule Loading (loader.ts)

```
1. Load always-on domain rules (read their .md files)
2. Load matched domain rules
3. Load star-command rules from commands.json
4. Load bracket rules from context.json based on current bracket
5. Return LoadedRules object
```

### .md File Parser

```
1. Read file as UTF-8
2. Split by newlines
3. For each line:
   - Trim whitespace
   - Skip empty lines
   - Skip lines starting with # (headings)
   - If starts with "- ", strip prefix and collect as rule
   - Otherwise skip (allow freeform markdown that isn't rules)
```

## Plugin Entry Point (src/index.ts)

```typescript
// Pseudocode structure
export const OpenCarly: Plugin = async ({ directory, client }) => {
  const configPath = discoverConfig(directory)
  if (!configPath) return {} // No .opencarly/ found, plugin is inert
  
  const config = loadConfig(configPath)
  let lastMatch: MatchResult | null = null
  let sessions: Map<string, SessionConfig> = new Map()

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        // Init session, clean stale sessions
      }
    },

    "chat.message": async (input, output) => {
      // Extract prompt text from output.parts
      const prompt = extractPromptText(output.parts)
      
      // Get/create session, bump prompt count
      const session = getOrCreateSession(input.sessionID, directory, configPath)
      session.promptCount++
      
      // Merge session overrides
      const effectiveConfig = applyOverrides(config, session)
      
      // Run matcher
      lastMatch = matchDomains(prompt, effectiveConfig)
      
      // Persist session
      saveSession(session, configPath)
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!lastMatch) return
      
      const session = sessions.get(input.sessionID)
      const effectiveConfig = applyOverrides(config, session)
      
      // Load rules
      const rules = await loadRules(lastMatch, effectiveConfig, configPath)
      
      // Get bracket
      const bracket = getBracket(session?.promptCount ?? 0, effectiveConfig.context)
      rules.bracket = bracket.name
      rules.bracketRules = bracket.rules
      
      // Format and inject
      const formatted = formatRules(rules)
      output.system.push(formatted)
    },
  }
}
```

## Installer (bin/install.js)

Interactive CLI:
1. Ask: global (`~/.config/opencarly/`) or local (`./.opencarly/`)?
2. Copy `templates/.opencarly/*` to target (skip if already exists)
3. Merge `"opencarly"` into `opencode.json` plugin array
4. Optionally add integration block to `AGENTS.md`
5. Copy `commands/carly-manager.md` to `.opencode/commands/`

Flags: `--global`, `--local`, `--skip-agents-md`

---

## Implementation Todo List

> Check items off as completed. This is the source of truth for progress.

### Phase 0: Scaffolding
- [x] Create DESIGN.md (this file)
- [x] Remove old src/types/ directory and empty placeholder dirs
- [x] Update package.json
- [x] Verify tsconfig.json
- [x] Update .gitignore

### Phase 1: Config & Schema
- [x] src/config/schema.ts - Zod schemas for manifest, commands, context, session
- [x] src/config/discovery.ts - Find .opencarly/ directory
- [x] src/config/manifest.ts - Parse and validate all config files
- [x] src/config/index.ts - Barrel exports

### Phase 2: Engine
- [x] src/engine/matcher.ts - matchDomains() + detectStarCommands()
- [x] src/engine/loader.ts - loadRules() + parseDomainFile()
- [x] src/engine/brackets.ts - getBracket()
- [x] src/engine/index.ts - Barrel exports

### Phase 3: Session Management
- [x] src/session/session.ts - getOrCreateSession, updateSession, applyOverrides, cleanStale, saveSession

### Phase 4: Formatter
- [x] src/formatter/formatter.ts - formatRules()

### Phase 5: Plugin Entry Point
- [x] src/index.ts - OpenCarly plugin function with hook wiring

### Phase 6: Templates
- [x] templates/.opencarly/manifest.json
- [x] templates/.opencarly/commands.json
- [x] templates/.opencarly/context.json
- [x] templates/.opencarly/domains/global.md
- [x] templates/.opencarly/domains/development.md
- [x] templates/.opencarly/domains/testing.md
- [x] templates/.opencarly/domains/security.md

### Phase 7: Installer
- [x] bin/install.js

### Phase 8: Custom Commands
- [x] commands/carly-manager.md

### Phase 9: Build & Validate
- [x] tsc compiles without errors
- [ ] Plugin loads in OpenCode without crashing
- [ ] Domains trigger correctly on keyword match
- [ ] Star-commands detected and rules injected
- [ ] Session state persists across prompts
- [ ] DEVMODE toggle works

### Phase 10: Polish
- [ ] README.md
- [ ] Final code review
- [ ] Clean up any TODOs in code

---

## Current Status

**Active Phase**: 9 - Build & Validate (tsc passes, needs live testing)
**Last Completed**: Phase 8 - All source files and templates created
**Blockers**: Need to test plugin in a live OpenCode session

## File Inventory (all files created)

```
Source (11 files):
  src/index.ts                       - Plugin entry point (OpenCarly export + default export)
  src/config/schema.ts               - Zod schemas: Manifest, DomainConfig, StarCommand, ContextBracket, Session
  src/config/discovery.ts            - discoverConfig(): walks up from cwd, falls back to ~/.config/opencarly/
  src/config/manifest.ts             - loadConfig(), parseDomainFile(), reloadConfig()
  src/config/index.ts                - Barrel exports
  src/engine/matcher.ts              - matchDomains(), detectStarCommands()
  src/engine/loader.ts               - loadRules()
  src/engine/brackets.ts             - getBracket()
  src/engine/index.ts                - Barrel exports
  src/session/session.ts             - getOrCreateSession, saveSession, updateSessionActivity, applySessionOverrides, cleanStaleSessions
  src/formatter/formatter.ts         - formatRules()

Templates (7 files):
  templates/.opencarly/manifest.json   - Default manifest with global, development, testing, security domains
  templates/.opencarly/commands.json   - 8 star-commands: dev, review, brief, plan, discuss, debug, explain, carly
  templates/.opencarly/context.json    - Bracket thresholds (15/35/50) and rules for fresh/moderate/depleted
  templates/.opencarly/domains/global.md
  templates/.opencarly/domains/development.md
  templates/.opencarly/domains/testing.md
  templates/.opencarly/domains/security.md

Other:
  bin/install.js                     - CLI installer (npx opencarly)
  commands/carly-manager.md          - /carly custom command for OpenCode
  package.json, tsconfig.json, .gitignore, DESIGN.md
```
