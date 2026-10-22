// Linear, Jira and GitLab (backend: app/src-tauri/src/integrations.rs). Tokens live in the OS
// credential store; the UI only knows whether one is set.
import { invoke } from "@tauri-apps/api/core";
import { store } from "./store";
import type { Project } from "./types";

export type IssueSource = "linear" | "jira" | "gitlab";

export interface Issue {
  source: IssueSource;
  id: string;
  key: string;
  title: string;
  url: string;
  state: string;
  state_kind: "open" | "progress" | "done" | "other";
  priority: string | null;
  branch: string | null;
  description: string | null;
  team: string | null;
  updated: string | null;
}

export interface IssueState {
  id: string;
  name: string;
  state_kind: string;
}

export interface JiraSite {
  url: string;
  /** Cloud: the account's e-mail (with an API token); empty for Server / Data Center (personal access token). */
  email: string;
}

export interface MergeRequest {
  iid: number;
  title: string;
  url: string;
  state: "opened" | "merged" | "closed";
  draft: boolean;
  target: string;
  pipeline: string | null;
  merge_status: string | null;
}

export const secretSet = (key: string, value: string) => invoke<void>("integration_secret_set", { key, value });
export const secretClear = (key: string) => invoke<void>("integration_secret_clear", { key });
export const secretHas = (key: string) => invoke<boolean>("integration_secret_has", { key });

export const jiraKey = (site: JiraSite) => `jira:${site.url.trim().replace(/\/+$/, "")}`;
export const gitlabKey = (host: string) => `gitlab:${host.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase()}`;

export const linearIssues = (search?: string) => invoke<Issue[]>("linear_issues", { search });
export const linearStates = (issueId: string) => invoke<IssueState[]>("linear_states", { issueId });
export const linearSetState = (issueId: string, stateId: string) => invoke<void>("linear_set_state", { issueId, stateId });
export const linearViewer = () => invoke<string>("linear_viewer");

export const jiraIssues = (site: JiraSite, search?: string, jql?: string) => invoke<Issue[]>("jira_issues", { site, search, jql });
export const jiraTransitions = (site: JiraSite, key: string) => invoke<IssueState[]>("jira_transitions", { site, key });
export const jiraTransition = (site: JiraSite, key: string, transition: string) => invoke<void>("jira_transition", { site, key, transition });
export const jiraMyself = (site: JiraSite) => invoke<string>("jira_myself", { site });

/** Self-hosted GitLab hosts the user connected (gitlab.com and hosts named *gitlab* are known). */
export const gitlabHosts = () => store.state.settings.integrations?.gitlabHosts ?? [];
export const gitlabProject = (root: string) => invoke<{ host: string; path: string; connected: boolean } | null>("gitlab_project", { root, hosts: gitlabHosts() });
export const gitlabMrStatus = (root: string) => invoke<MergeRequest | null>("gitlab_mr_status", { root, hosts: gitlabHosts() });
export const gitlabDefaultBranch = (root: string) => invoke<string | null>("gitlab_default_branch", { root, hosts: gitlabHosts() });
export const gitlabMrCreate = (root: string, title: string, description: string, target: string, draft: boolean) =>
  invoke<string>("gitlab_mr_create", { root, hosts: gitlabHosts(), title, description, target, draft });
export const gitlabIssues = (root: string, search?: string) => invoke<Issue[]>("gitlab_issues", { root, hosts: gitlabHosts(), search });
export const gitlabUser = (host: string) => invoke<string>("gitlab_user", { host });

/** The issue as an agent prompt. */
export function issuePrompt(issue: Issue, instruction = "Work on this issue."): string {
  const parts = [`${instruction}`, "", `${issue.key}: ${issue.title}`, issue.url];
  if (issue.description) parts.push("", issue.description);
  return parts.join("\n");
}

/** A branch for the issue: the tracker's suggestion (Linear), else key + title. */
export function issueBranch(issue: Issue): string {
  if (issue.branch) return issue.branch;
  const slug = `${issue.key}-${issue.title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return slug.replace(/-+$/, "") || "issue";
}

/** Starts an agent on the issue in `project` (prompt = the issue). */
export function startOnIssue(project: Project, issue: Issue, kind = store.state.settings.aiAgent ?? "claude") {
  return store.newSession(project.id, kind, { prompt: issuePrompt(issue), name: issue.key });
}
