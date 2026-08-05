export interface NoteScanOptions {
  providers: Readonly<Record<string, string>>;
  repositoryAliases?: ReadonlyMap<string, string>;
}

export interface SourceSpan {
  start: number;
  end: number;
}

export interface LineSpan extends SourceSpan {
  lineEnding: string;
  indentation: string;
}

export type ContextProvenance = 'direct' | 'ancestor';

export interface RepositoryContext {
  repository: string;
  provenance: ContextProvenance;
}

export interface PullRequestContext extends RepositoryContext {
  url: string;
}

export interface DirectiveContext {
  dayHeading: string | null;
  ancestors: string[];
  repository?: RepositoryContext;
  pr?: PullRequestContext;
}

export interface ReceiptRegion extends SourceSpan {
  taskId: string;
}

export interface EventRegion extends LineSpan {
  taskId: string;
  eventKey: string;
  checked: boolean;
}

export interface ParsedDirective {
  taskId: string | null;
  receiptAnchor: string | null;
  provider: string;
  providerDirective: string;
  directiveText: string;
  taskSpan: LineSpan;
  itemSpan: SourceSpan;
  checkboxSpan: SourceSpan;
  dayHeading: string | null;
  listAncestors: string[];
  context: DirectiveContext;
  identityInsertOffset: number;
  childIndentation: string;
  receipt: ReceiptRegion | null;
  eventRegions: EventRegion[];
  conflicted: boolean;
  sourceChecked: boolean;
}

export type NoteConflictKind =
  | 'duplicate-task-id'
  | 'duplicate-anchor'
  | 'malformed-marker'
  | 'ambiguous-task-marker'
  | 'malformed-event-marker';

export interface NoteConflict {
  kind: NoteConflictKind;
  message: string;
  span: SourceSpan;
  taskId?: string;
}

export interface NoteScan {
  source: string;
  sourceHash: string;
  newline: '\n' | '\r\n';
  hasBom: boolean;
  directives: ParsedDirective[];
  trackedTasks: ParsedDirective[];
  conflicts: NoteConflict[];
  receiptRegions: ReceiptRegion[];
  eventRegions: EventRegion[];
}

export function configuredDirectives(
  providers: Readonly<Record<string, string>>,
): Array<{ provider: string; directive: string }> {
  return Object.entries(providers)
    .map(([provider, directive]) => ({ provider, directive }))
    .sort((left, right) => right.directive.length - left.directive.length);
}
