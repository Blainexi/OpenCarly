/**
 * OpenCarly Config Discovery
 *
 * Finds the .opencarly/ configuration directory by:
 * 1. Walking up from cwd looking for a local .opencarly/ with a manifest.json
 * 2. Falling back to ~/.config/opencarly/ (global config)
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const CONFIG_DIR_NAME = ".opencarly";
const MANIFEST_FILE = "manifest.json";
const MAX_WALK_DEPTH = 10;

export interface DiscoveryResult {
  /** Absolute path to the .opencarly/ directory */
  configPath: string;

  /** Whether this is a local or global config */
  scope: "local" | "global";
}

/**
 * Discover the .opencarly/ configuration directory.
 *
 * Walks up from `startDir` looking for a `.opencarly/manifest.json`.
 * Falls back to `~/.config/opencarly/manifest.json`.
 * Returns null if no config found anywhere.
 */
export function discoverConfig(startDir: string): DiscoveryResult | null {
  // 1. Walk up from startDir looking for local .opencarly/
  let current = path.resolve(startDir);
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    const candidate = path.join(current, CONFIG_DIR_NAME);
    const manifestPath = path.join(candidate, MANIFEST_FILE);

    if (fs.existsSync(manifestPath)) {
      return { configPath: candidate, scope: "local" };
    }

    const parent = path.dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }

  // 2. Check global config
  const globalConfig = path.join(os.homedir(), ".config", "opencarly");
  const globalManifest = path.join(globalConfig, MANIFEST_FILE);

  if (fs.existsSync(globalManifest)) {
    return { configPath: globalConfig, scope: "global" };
  }

  return null;
}
