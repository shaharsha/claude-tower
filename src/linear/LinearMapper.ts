import { TowerTask, LinearTicket } from '../types';

/**
 * Convert a Linear ticket into a new TowerTask with status=backlog, source=linear.
 */
export function mapLinearTicketToTask(ticket: LinearTicket): TowerTask {
  return {
    id: `linear-${ticket.id}`,
    title: ticket.title,
    description: ticket.description,
    status: 'backlog',
    source: 'linear',
    mode: 'worktree',

    linearIssueId: ticket.id,
    linearIssueUrl: ticket.url,
    linearLabels: ticket.labels,
    linearPriority: ticket.priority,

    sessions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    isRead: false,
  };
}

/**
 * Find the Linear ticket that corresponds to a TowerTask.
 * Matches by linearIssueId first, then by extracting a Linear identifier
 * (e.g. TEN-42) from the task's branch name.
 */
export function matchTaskToTicket(
  task: TowerTask,
  tickets: LinearTicket[],
): LinearTicket | undefined {
  // Direct ID match
  if (task.linearIssueId) {
    const match = tickets.find((t) => t.id === task.linearIssueId);
    if (match) {
      return match;
    }
  }

  // Try to extract a Linear identifier from the branch name
  if (task.branch) {
    // Linear identifiers look like ABC-123
    const match = task.branch.match(/([A-Z]{2,10}-\d+)/i);
    if (match) {
      const identifier = match[1].toUpperCase();
      return tickets.find(
        (t) => t.identifier.toUpperCase() === identifier,
      );
    }
  }

  return undefined;
}

/**
 * Generate a git branch name from a Linear ticket.
 *
 * Example: `feat/TEN-42-fix-pdf-parsing`
 */
export function buildBranchName(ticket: LinearTicket, prefix?: string): string {
  const branchPrefix = prefix ?? 'feat';

  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumeric -> dash
    .replace(/^-+|-+$/g, '')     // trim leading/trailing dashes
    .slice(0, 50)                // keep it reasonable
    .replace(/-+$/, '');         // trim any trailing dash after slice

  return `${branchPrefix}/${ticket.identifier}-${slug}`;
}
