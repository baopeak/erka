// GitHub pull request of each project's current branch (via `gh`), cached for the sidebar
// chip and the Changes panel. Fetched when the panel opens and after a push.
import { createRoot } from "solid-js";
import { createStore } from "solid-js/store";
import { ghPrStatus, type PullRequest } from "./ipc";

function createPrStore() {
  const [prs, setPrs] = createStore<Record<string, PullRequest | null>>({});
  const inFlight = new Set<string>();

  async function refresh(projectId: string, root: string) {
    if (inFlight.has(projectId)) return;
    inFlight.add(projectId);
    try {
      setPrs(projectId, await ghPrStatus(root));
    } catch {
      // gh missing or signed out: no chip, no error toast for a background check.
      setPrs(projectId, null);
    } finally {
      inFlight.delete(projectId);
    }
  }

  return { prs, refresh };
}

export const pullRequests = createRoot(createPrStore);

export const prLabel = (pr: PullRequest) => (pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.draft ? "draft" : "open");
