import { receiptAnchorFor } from './anchor.js';

export type ReceiptStatus =
  | 'Queued'
  | 'Working'
  | 'Needs input'
  | 'Cancellation requested'
  | 'Completed'
  | 'Failed'
  | 'Cancelled';

export interface ReceiptModel {
  taskId: string;
  sessionId: string | null;
  status: ReceiptStatus;
  updatedAt: string;
  context: string;
  inspectCommand?: readonly string[];
  inspectCommandDirectory?: string;
  cancelCommand?: readonly string[];
  latestOutput?: string;
  workspaceQuarantine?: string | null;
  maxOutputCharacters?: number;
}

export interface FollowUpTodoModel {
  checked: boolean;
  eventKey: string;
  taskId: string;
  text: string;
  command?: readonly string[];
  commandDirectory?: string;
  indentation: string;
  backlink?: string;
}

export const MAX_GENERATED_FOLLOW_UP_TEXT_LENGTH = 500;

function stripControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 0x1f ||
        (point >= 0x7f && point <= 0x9f) ||
        point === 0x2028 ||
        point === 0x2029
        ? ' '
        : character;
    })
    .join('');
}

function singleLine(value: string): string {
  return stripControlCharacters(value)
    .replace(/<!--[^]*?-->/g, ' ')
    .replace(/[<>"\\]/g, ' ')
    .replace(/--+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function safeMarkerValue(value: string): string {
  return singleLine(value) || 'unknown';
}

function safeVisibleLine(value: string): string {
  return stripControlCharacters(value).replace(/\s+/g, ' ').trim();
}

function containGeneratedSyntax(value: string): string {
  return value
    .replaceAll('<!--', '⟨!--')
    .replaceAll('-->', '--⟩')
    .replace(/spool:(?:receipt|task|event)/gi, (match) => match.replace(':', '꞉'))
    .replace(/data-spool-(?:event|task)/gi, (match) => match.replace('-', '꞉'));
}

/**
 * Follow-up text can include filesystem inspection detail. Keep that detail inert even when it
 * contains copied Markdown controls, generated marker HTML, or receipt fence syntax. Bounding is
 * deliberately last so the emitted visible detail cannot grow again after neutralization.
 */
export function sanitizeGeneratedFollowUpText(
  value: string,
  maximum = MAX_GENERATED_FOLLOW_UP_TEXT_LENGTH,
): string {
  const neutralized = safeVisibleLine(
    containGeneratedSyntax(
      value
        .replace(/<!--[^]*?-->/gu, ' ')
        .replace(
          /<span\b[^>\r\n]*(?:data-spool-event|data-spool-task)[^>\r\n]*>(?:<\/span>)?/giu,
          ' ',
        )
        .replace(/`{3,}[\t ]*spool/giu, 'spool'),
    ),
  ).replace(/(^|\s)((?:[-+*]|\d+[.)])\s+)\[([ xX])\]/gu, '$1$2［$3］');
  if (maximum <= 0) return '';
  if (neutralized.length <= maximum) return neutralized;
  if (maximum === 1) return '…';
  return `${neutralized.slice(0, maximum - 1)}…`;
}

function longestBacktickRun(value: string): number {
  return Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
}

export function renderCodeSpan(value: string): string {
  const clean = safeVisibleLine(value);
  const delimiter = '`'.repeat(Math.max(1, longestBacktickRun(clean) + 1));
  const padding = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
  return `${delimiter}${padding}${clean}${padding}${delimiter}`;
}

function shellDisplayArgument(value: string): string {
  const clean = safeVisibleLine(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(clean)) {
    return clean;
  }
  return `'${clean.replaceAll("'", `'"'"'`)}'`;
}

export function renderCommand(argv: readonly string[], directory?: string): string {
  return renderCodeSpan(renderCommandText(argv, directory));
}

export function renderCommandText(argv: readonly string[], directory?: string): string {
  const command = argv.map(shellDisplayArgument).join(' ');
  return directory ? `cd ${shellDisplayArgument(directory)} && ${command}` : command;
}

export function renderReceipt(model: ReceiptModel, newline = '\n'): string {
  const taskId = safeMarkerValue(model.taskId);
  const sessionId = model.sessionId === null ? 'pending' : safeVisibleLine(model.sessionId);
  const maximum = model.maxOutputCharacters ?? 4_000;
  const rawOutput = model.latestOutput ?? '';
  const boundedOutput =
    rawOutput.length > maximum
      ? `${rawOutput.slice(0, maximum)}${newline}… output truncated by spool …`
      : rawOutput;
  const output = containGeneratedSyntax(boundedOutput);
  const context = containGeneratedSyntax(model.context);
  const command = model.inspectCommand
    ? renderCommandText(model.inspectCommand, model.inspectCommandDirectory)
    : null;
  const cancellation =
    model.cancelCommand &&
    ['Queued', 'Working', 'Needs input', 'Cancellation requested'].includes(model.status)
      ? `Cancel: ${safeVisibleLine(model.cancelCommand.map(shellDisplayArgument).join(' '))}`
      : null;
  const lines = [
    `Task: ${taskId}`,
    `Anchor: ${receiptAnchorFor(taskId)}`,
    `Session: ${sessionId}`,
    `Status: ${model.status}`,
    `Last update: ${safeVisibleLine(model.updatedAt)}`,
    '',
    'Context:',
    context || '(none)',
    ...(command ? ['', `Inspect: ${command}`] : []),
    ...(cancellation ? [cancellation] : []),
    ...(model.workspaceQuarantine
      ? [`Workspace: Quarantined — ${safeVisibleLine(model.workspaceQuarantine)}`]
      : []),
    '',
    'Latest output:',
    output || '(none)',
  ];
  const body = lines.join(newline);
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1));
  return [`${fence}spool`, body, fence].join(newline);
}

export function renderEventMetadata(eventKey: string, taskId: string): string {
  return `<span data-spool-event="${safeMarkerValue(eventKey)}" data-spool-task="${safeMarkerValue(taskId)}"></span>`;
}

export function renderFollowUpTodo(model: FollowUpTodoModel, newline = '\n'): string {
  const taskId = safeMarkerValue(model.taskId);
  const eventKey = safeMarkerValue(model.eventKey);
  const text = sanitizeGeneratedFollowUpText(model.text);
  const command = model.command ? ` ${renderCommand(model.command, model.commandDirectory)}` : '';
  const backlink = model.backlink ? ` ${safeVisibleLine(model.backlink)}` : '';
  return `${model.indentation}- [${model.checked ? 'x' : ' '}] ${text}${command}${backlink} ${renderEventMetadata(eventKey, taskId)}${newline}`;
}
