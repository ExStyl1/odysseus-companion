export interface KnowledgeNode {
  id: string;
  label: string;
  type?: string;
  description?: string;
  source_file?: string;
  source_line?: number;
  project_id?: string;
  childCount?: number;
  manual?: boolean;
  stale?: boolean;
  pending?: boolean;
  graphify_project_path?: string;
}
export interface KnowledgeLink {
  id?: string;
  source: string;
  target: string;
  relation?: string;
  description?: string;
  confidence?: string;
  source_file?: string;
  source_line?: number;
  manual?: boolean;
}
export interface KnowledgeView {
  scopeCollection?: string;
  collections?: { id: string; name: string; count: number }[];
  allProjects?: { id: string; label: string; collectionId: string }[];
  anchorCount?: number;
  version?: string;
  unchanged?: boolean;
  scopeProject?: string;
  breadcrumbs?: { id: string; label: string }[];
  ready: boolean;
  totalNodes: number;
  totalLinks: number;
  totalMatches: number;
  offset: number;
  limit: number;
  hiddenLinks: number;
  projects: {
    id: string;
    label: string;
    path?: string;
    stale?: boolean;
    pending?: boolean;
  }[];
  nodes: KnowledgeNode[];
  links: KnowledgeLink[];
  overlayRevision?: number;
  lastError?: { error: string } | null;
}
export type KnowledgeEdit =
  | {
      type: "add-note";
      label: string;
      description: string;
      parent?: string;
      collection?: string;
    }
  | {
      type: "add-link";
      source: string;
      target: string;
      relation: string;
      evidence: string;
      collection?: string;
    }
  | { type: "remove-manual"; id: string };

export interface KnowledgeDocument {
  path: string;
  content: string;
  markdown?: boolean;
  binary: boolean;
  truncated: boolean;
}
