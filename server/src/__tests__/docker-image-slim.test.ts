import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Slim production image for the Alibaba Cloud deployment
 * (deploy/aliyun/docs/adr/0001-slim-production-image.md).
 *
 * Upstream builds keep their defaults (all five CLIs, provider pack). Only the
 * Alibaba Cloud deploy workflow passes the slim build arguments.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const deployWorkflow = readFileSync(path.join(repoRoot, ".github", "workflows", "deploy-aliyun.yml"), "utf8");

const UPSTREAM_CLIS = [
  "@anthropic-ai/claude-code@latest",
  "@openai/codex@latest",
  "opencode-ai",
  "@google/gemini-cli@latest",
  "@moonshot-ai/kimi-code@latest",
];

function stageBody(source: string, stageName: string): string {
  const froms = [...source.matchAll(/^FROM .*$/gm)];
  const startIdx = froms.findIndex((m) => new RegExp(`\\bAS ${stageName}\\s*$`).test(m[0]));
  expect(startIdx, `Dockerfile must declare a '${stageName}' stage`).toBeGreaterThanOrEqual(0);
  const start = froms[startIdx].index ?? 0;
  const end = froms[startIdx + 1]?.index ?? source.length;
  return source.slice(start, end);
}

describe("global agent CLIs", () => {
  const production = stageBody(dockerfile, "production");
  const tools = production.search(/^RUN echo "cli-tools-epoch:/m);

  it("installs a configurable CLI list that defaults to the upstream five", () => {
    const declaration = production.match(/^ARG CLI_TOOLS="([^"]*)"$/m);
    expect(declaration, "production stage must declare ARG CLI_TOOLS with a default").not.toBeNull();
    expect(declaration!.index).toBeLessThan(tools);
    expect(declaration![1].split(/\s+/)).toEqual(UPSTREAM_CLIS);
    expect(production).toMatch(/npm install --global --omit=dev \$\{CLI_TOOLS\}/);
  });

  it("removes the npm download cache in the install layer", () => {
    const toolsRun = production.slice(tools, production.indexOf("\n\n", tools));
    expect(toolsRun).toContain("npm cache clean --force");
  });
});

describe("runner provider pack", () => {
  it("can be skipped with PAPERCLIP_SKIP_PROVIDER_PACK", () => {
    const pack = stageBody(dockerfile, "runner-provider-pack");
    expect(pack).toMatch(/^ARG PAPERCLIP_SKIP_PROVIDER_PACK=""$/m);
    expect(pack).toContain('if [ "${PAPERCLIP_SKIP_PROVIDER_PACK}" = "true" ]; then');
    expect(pack.indexOf("PAPERCLIP_SKIP_PROVIDER_PACK}\" = \"true\"")).toBeLessThan(
      pack.indexOf("build-provider-pack.mjs"),
    );
  });
});

describe("Alibaba Cloud deploy workflow", () => {
  it("builds the slim image", () => {
    const cliArg = deployWorkflow.match(/^\s*CLI_TOOLS=(.+)$/m);
    expect(cliArg, "deploy workflow must pass CLI_TOOLS").not.toBeNull();
    expect(cliArg![1].trim().split(/\s+/)).toEqual([
      "@anthropic-ai/claude-code@latest",
      "@openai/codex@latest",
      "@moonshot-ai/kimi-code@latest",
    ]);
    expect(deployWorkflow).toMatch(/^\s*PAPERCLIP_SKIP_PROVIDER_PACK=true$/m);
  });
});
