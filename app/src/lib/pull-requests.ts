// The pull request (GitHub, via `gh`) or merge request (GitLab, its API) of each project's
// current branch, cached for the sidebar chip and the Changes panel. Fetched when the panel
// opens and after a push.
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { ghPrStatus, type PullRequest } from "./ipc";
import { gitlabMrStatus, gitlabProject, type MergeRequest } from "./integrations";

/** GitLab pipeline status → the checks summary GitHub PRs use. */
function checksOf(pipeline: string | null): PullRequest["checks"] {
  if (!pipeline) return "none";
  if (pipeline === "success") return "passing";
  if (["failed", "canceled"].includes(pipeline)) return "failing";
  return "pending";
}

export const fromMergeRequest = (mr: MergeRequest): PullRequest => ({
  number: mr.iid, title: mr.title, url: mr.url, draft: mr.draft, base: mr.target, provider: "gitlab",
  state: mr.state === "merged" ? "MERGED" : mr.state === "closed" ? "CLOSED" : "OPEN",
  checks: checksOf(mr.pipeline),
});

function createPrStore() {
  const [prs, setPrs] = createStore<Record<string, PullRequest | null>>({});
  /** Where each project's remote lives (decides PR vs MR, `gh` vs the GitLab API). */
  const [providers, setProviders] = createStore<Record<string, "github" | "gitlab">>({});
  const inFlight = new Set<string>();

  async function refresh(projectId: string, root: string) {
    if (inFlight.has(projectId)) return;
    inFlight.add(projectId);
    try {
      const gitlab = await gitlabProject(root).catch(() => null);
      setProviders(projectId, gitlab ? "gitlab" : "github");
      if (gitlab) {
        const mr = await gitlabMrStatus(root);
        setPrs(projectId, mr ? fromMergeRequest(mr) : null);
      } else {
        const pr = await ghPrStatus(root);
        setPrs(projectId, pr ? { ...pr, provider: "github" } : null);
      }
    } catch {
      // gh missing or signed out: no chip, no error toast for a background check.
      setPrs(projectId, null);
    } finally {
      inFlight.delete(projectId);
    }
  }

  return { prs, providers, refresh };
}

export const pullRequests = createRoot(createPrStore);

export const prLabel = (pr: PullRequest) => (pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.draft ? "draft" : "open");
