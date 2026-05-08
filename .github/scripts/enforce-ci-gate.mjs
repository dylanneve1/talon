import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

const config = JSON.parse(
  readFileSync(new URL("../branch-protection.json", import.meta.url), "utf8"),
);

const token =
  process.env.GITHUB_TOKEN || process.env.GH_TOKEN || readGhAuthToken();
if (!token) {
  throw new Error(
    "Set GITHUB_TOKEN or GH_TOKEN with repository administration permission, or authenticate the GitHub CLI with `gh auth login`.",
  );
}

const remote = execFileSync("git", ["remote", "get-url", "origin"], {
  encoding: "utf8",
}).trim();
const match = remote.match(
  /github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/.]+)(?:\.git)?$/,
);
if (!match?.groups) {
  throw new Error(`Could not infer GitHub owner/repo from origin: ${remote}`);
}

const { owner, repo } = match.groups;
const { branch, ...protection } = config;
const route = `repos/${owner}/${repo}/branches/${branch}/protection`;
const body = JSON.stringify(protection);

try {
  await applyWithFetch(route, body);
} catch (error) {
  const gh = spawnSync("gh", ["api", "-X", "PUT", route, "--input", "-"], {
    input: body,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: token },
  });
  if (gh.status !== 0) {
    throw new Error(
      `Failed to protect ${owner}/${repo}@${branch}.\nfetch error: ${
        error instanceof Error ? error.message : error
      }\ngh error: ${gh.stderr || gh.stdout}`,
    );
  }
}

console.log(
  `Protected ${owner}/${repo}@${branch}: required status check "CI Status" must pass before merge.`,
);

async function applyWithFetch(route, body) {
  const response = await fetch(`https://api.github.com/${route}`, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}\n${await response.text()}`,
    );
  }
}

function readGhAuthToken() {
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
