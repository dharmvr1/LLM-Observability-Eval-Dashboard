import path from "path";
import type { NextConfig } from "next";

const config: NextConfig = {
  // Tell Next this folder is the project root (another lockfile higher up made it guess wrong).
  outputFileTracingRoot: path.join(process.cwd()),
  // Hide the dev-mode indicator badge (shows up in the bottom corner of screenshots).
  devIndicators: false,
};
export default config;
