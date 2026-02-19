#!/usr/bin/env node

/**
 * OpenCarly Installer
 *
 * Sets up the .opencarly/ configuration directory and registers the plugin
 * with OpenCode.
 *
 * Usage:
 *   npx opencarly              # Interactive install
 *   npx opencarly --local      # Install to ./.opencarly/ (non-interactive)
 *   npx opencarly --global     # Install to ~/.config/opencarly/ (non-interactive)
 *   npx opencarly --skip-agents-md  # Don't modify AGENTS.md
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const TEMPLATES_DIR = path.join(PACKAGE_ROOT, "templates", ".opencarly");
const COMMANDS_DIR = path.join(PACKAGE_ROOT, "commands");

const AGENTS_MD_BLOCK = `
<!-- OPENCARLY-MANAGED: Do not remove this section -->
## OpenCarly Integration

Follow all rules in <carly-rules> blocks injected into the system prompt.
These are dynamically injected based on context and MUST be obeyed.
They take precedence over general instructions when present.
<!-- END OPENCARLY-MANAGED -->
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      // Don't overwrite existing files
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`  Created: ${destPath}`);
      } else {
        console.log(`  Skipped (exists): ${destPath}`);
      }
    }
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

function registerPlugin(projectDir) {
  const configPath = path.join(projectDir, "opencode.json");

  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      console.log("  Warning: Could not parse existing opencode.json, creating new one");
      config = {};
    }
  }

  // Add opencarly to plugin array
  if (!config.plugin) {
    config.plugin = [];
  }

  if (!config.plugin.includes("opencarly")) {
    config.plugin.push("opencarly");
  }

  // Ensure $schema is set
  if (!config.$schema) {
    config.$schema = "https://opencode.ai/config.json";
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  console.log(`  Updated: ${configPath}`);
}

// ---------------------------------------------------------------------------
// AGENTS.md integration
// ---------------------------------------------------------------------------

function addAgentsMdBlock(projectDir) {
  const agentsPath = path.join(projectDir, "AGENTS.md");

  if (fs.existsSync(agentsPath)) {
    const content = fs.readFileSync(agentsPath, "utf-8");

    // Check if block already exists
    if (content.includes("OPENCARLY-MANAGED")) {
      console.log("  Skipped AGENTS.md (OpenCarly block already present)");
      return;
    }

    // Insert after first heading, or at the end
    const firstHeadingMatch = content.match(/^#[^#].+$/m);
    let newContent;
    if (firstHeadingMatch) {
      const insertPos = content.indexOf(firstHeadingMatch[0]) + firstHeadingMatch[0].length;
      newContent =
        content.slice(0, insertPos) +
        "\n" +
        AGENTS_MD_BLOCK +
        content.slice(insertPos);
    } else {
      newContent = content + "\n" + AGENTS_MD_BLOCK;
    }

    fs.writeFileSync(agentsPath, newContent, "utf-8");
    console.log(`  Updated: ${agentsPath}`);
  } else {
    // Create AGENTS.md with the block
    fs.writeFileSync(
      agentsPath,
      `# Project Instructions\n${AGENTS_MD_BLOCK}`,
      "utf-8"
    );
    console.log(`  Created: ${agentsPath}`);
  }
}

// ---------------------------------------------------------------------------
// Install custom commands
// ---------------------------------------------------------------------------

function installCommands(projectDir) {
  const destDir = path.join(projectDir, ".opencode", "commands");
  ensureDir(destDir);

  if (fs.existsSync(COMMANDS_DIR)) {
    const files = fs.readdirSync(COMMANDS_DIR);
    for (const file of files) {
      const srcPath = path.join(COMMANDS_DIR, file);
      const destPath = path.join(destDir, file);

      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`  Created: ${destPath}`);
      } else {
        console.log(`  Skipped (exists): ${destPath}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  const isGlobal = args.includes("--global") || args.includes("-g");
  const isLocal = args.includes("--local") || args.includes("-l");
  const skipAgentsMd = args.includes("--skip-agents-md");
  const showHelp = args.includes("--help") || args.includes("-h");

  if (showHelp) {
    console.log(`
OpenCarly Installer - Dynamic rules for OpenCode

Usage:
  npx opencarly              Interactive install
  npx opencarly --local      Install to ./.opencarly/ (non-interactive)
  npx opencarly --global     Install to ~/.config/opencarly/ (non-interactive)

Options:
  --local, -l           Install to current project directory
  --global, -g          Install to global config directory
  --skip-agents-md      Don't modify AGENTS.md
  --help, -h            Show this help message
`);
    process.exit(0);
  }

  console.log("");
  console.log("  OpenCarly - Context Augmentation & Reinforcement Layer for OpenCode");
  console.log("  Dynamic rules that load when relevant, disappear when not.");
  console.log("");

  let installScope;
  let addBlock = !skipAgentsMd;

  if (isGlobal) {
    installScope = "global";
  } else if (isLocal) {
    installScope = "local";
  } else {
    // Interactive mode
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const scopeAnswer = await ask(
      rl,
      "  Install location?\n    1) Local (this project only - ./.opencarly/)\n    2) Global (all projects - ~/.config/opencarly/)\n  Choice [1]: "
    );
    installScope = scopeAnswer === "2" ? "global" : "local";

    if (!skipAgentsMd) {
      const agentsAnswer = await ask(
        rl,
        "  Add OpenCarly integration block to AGENTS.md? [Y/n]: "
      );
      addBlock = agentsAnswer.toLowerCase() !== "n";
    }

    rl.close();
  }

  const cwd = process.cwd();
  const targetDir =
    installScope === "global"
      ? path.join(os.homedir(), ".config", "opencarly")
      : path.join(cwd, ".opencarly");

  console.log("");
  console.log(`  Installing to: ${targetDir}`);
  console.log("");

  // 1. Copy templates
  console.log("  [1/4] Copying configuration templates...");
  copyDirRecursive(TEMPLATES_DIR, targetDir);

  // 2. Create sessions directory
  const sessionsDir = path.join(targetDir, "sessions");
  ensureDir(sessionsDir);
  const gitkeep = path.join(sessionsDir, ".gitkeep");
  if (!fs.existsSync(gitkeep)) {
    fs.writeFileSync(gitkeep, "", "utf-8");
  }

  // 3. Register plugin in opencode.json
  console.log("  [2/4] Registering plugin in opencode.json...");
  registerPlugin(cwd);

  // 4. Add AGENTS.md block
  if (addBlock) {
    console.log("  [3/4] Adding integration block to AGENTS.md...");
    addAgentsMdBlock(cwd);
  } else {
    console.log("  [3/4] Skipping AGENTS.md modification");
  }

  // 5. Install custom commands
  console.log("  [4/4] Installing custom commands...");
  installCommands(cwd);

  console.log("");
  console.log("  OpenCarly installed successfully!");
  console.log("");
  console.log("  Configuration: " + targetDir);
  console.log("  Edit manifest:  " + path.join(targetDir, "manifest.json"));
  console.log("  Edit commands:  " + path.join(targetDir, "commands.json"));
  console.log("  Edit brackets:  " + path.join(targetDir, "context.json"));
  console.log("  Add domains:    " + path.join(targetDir, "domains/"));
  console.log("");
  console.log("  Quick start:");
  console.log("    Type *carly in OpenCode for an interactive guide");
  console.log("    Type *dev, *brief, *plan, etc. for star-commands");
  console.log("    Run /carly for domain management");
  console.log("");
}

main().catch((err) => {
  console.error("Installation failed:", err.message);
  process.exit(1);
});
