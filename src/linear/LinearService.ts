import { LinearAuth } from './LinearAuth';
import { LinearConfig, LinearTicket, LinearAttachment } from '../types';

export class LinearService {
  private client: any;

  constructor(private readonly auth: LinearAuth) {}

  /**
   * Lazily create a LinearClient. Uses dynamic import so @linear/sdk is optional.
   */
  async initialize(): Promise<void> {
    const token = this.auth.getAccessToken();
    if (!token) {
      throw new Error('Not authenticated with Linear');
    }

    const { LinearClient } = await import('@linear/sdk');
    this.client = new LinearClient({ accessToken: token });
  }

  /**
   * Fetch backlog / unstarted / triage issues for the given team, applying
   * optional project and assignee filters.
   */
  async getBacklog(config: LinearConfig): Promise<LinearTicket[]> {
    this.ensureClient();

    const filter: Record<string, any> = {
      team: { id: { eq: config.teamId } },
      state: { type: { in: ['backlog', 'unstarted', 'triage'] } },
    };

    if (config.projectId) {
      filter.project = { id: { eq: config.projectId } };
    }

    if (config.filter === 'assigned') {
      filter.assignee = { isMe: { eq: true } };
    } else if (config.filter === 'unassigned') {
      filter.assignee = { null: true };
    }

    const issues = await this.client.issues({ filter });

    const tickets: LinearTicket[] = [];
    for (const issue of issues.nodes) {
      const state = await issue.state;
      const assignee = await issue.assignee;
      const labelNodes = await issue.labels();
      const attachmentNodes = await issue.attachments();

      const attachments: LinearAttachment[] = (attachmentNodes?.nodes ?? []).map(
        (a: any) => ({
          url: a.url,
          filename: LinearService.extractFilename(a.url, a.title),
          mimeType: a.metadata?.mimeType ?? 'application/octet-stream',
        }),
      );

      tickets.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? undefined,
        state: state?.name ?? 'Unknown',
        priority: issue.priority,
        labels: (labelNodes?.nodes ?? []).map((l: any) => l.name),
        assignee: assignee?.name ?? undefined,
        url: issue.url,
        attachments,
        acceptanceCriteria: (issue as any).acceptanceCriteria ?? undefined,
      });
    }

    return tickets;
  }

  /**
   * Fetch all actionable tickets across all teams in a SINGLE GraphQL query.
   * No N+1 — fetches issues with all relations in one round-trip.
   */
  async getAllTickets(): Promise<(LinearTicket & { teamName: string })[]> {
    this.ensureClient();

    const query = `
      query AllTickets {
        issues(
          filter: {
            state: { type: { in: ["backlog", "unstarted", "started", "triage"] } }
          }
          first: 200
        ) {
          nodes {
            id
            identifier
            title
            description
            priority
            priorityLabel
            url
            branchName
            state { name }
            team { name }
            assignee { name }
            labels { nodes { name } }
            attachments { nodes { url title } }
          }
        }
      }
    `;

    const result = await this.client.client.rawRequest(query);
    const nodes = (result?.data as any)?.issues?.nodes ?? [];

    const tickets: (LinearTicket & { teamName: string })[] = nodes.map((issue: any) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      state: issue.state?.name ?? 'Unknown',
      priority: issue.priority,
      labels: (issue.labels?.nodes ?? []).map((l: any) => l.name),
      assignee: issue.assignee?.name ?? undefined,
      url: issue.url,
      attachments: (issue.attachments?.nodes ?? []).map((a: any) => ({
        url: a.url,
        filename: LinearService.extractFilename(a.url, a.title),
        mimeType: 'application/octet-stream',
      })),
      teamName: issue.team?.name ?? 'Unknown',
    }));

    tickets.sort((a, b) => a.priority - b.priority || a.identifier.localeCompare(b.identifier));
    return tickets;
  }

  /**
   * Transition an issue to a new workflow state by name.
   */
  async updateIssueStatus(issueId: string, stateName: string): Promise<void> {
    this.ensureClient();

    // Fetch the issue to get its team
    const issue = await this.client.issue(issueId);
    const team = await issue.team;

    const states = await this.getWorkflowStates(team.id);
    const target = states.find(
      (s) => s.name.toLowerCase() === stateName.toLowerCase(),
    );

    if (!target) {
      throw new Error(
        `Workflow state "${stateName}" not found for team ${team.key}`,
      );
    }

    await this.client.updateIssue(issueId, { stateId: target.id });
  }

  /**
   * List workflow states for a team.
   */
  async getWorkflowStates(
    teamId: string,
  ): Promise<Array<{ id: string; name: string; type: string }>> {
    this.ensureClient();

    const team = await this.client.team(teamId);
    const statesConnection = await team.states();

    return (statesConnection?.nodes ?? []).map((s: any) => ({
      id: s.id,
      name: s.name,
      type: s.type,
    }));
  }

  /**
   * List all teams accessible to the authenticated user.
   */
  async getTeams(): Promise<Array<{ id: string; name: string }>> {
    this.ensureClient();

    const teams = await this.client.teams();
    return (teams?.nodes ?? []).map((t: any) => ({
      id: t.id,
      name: t.name,
    }));
  }

  /**
   * List projects for a given team.
   */
  async getProjects(
    teamId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    this.ensureClient();

    const team = await this.client.team(teamId);
    const projects = await team.projects();

    return (projects?.nodes ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
    }));
  }

  // ------------------------------------------------------------------

  /**
   * Extract a filename with extension from a URL, with title as fallback.
   * Linear attachment URLs look like: https://uploads.linear.app/.../image.png?X-Amz-...
   */
  private static extractFilename(url: string, title?: string): string {
    // Try to get filename from URL path (strip query params)
    try {
      const pathname = new URL(url).pathname;
      const urlFilename = pathname.split('/').pop();
      if (urlFilename && urlFilename.includes('.')) {
        return urlFilename;
      }
    } catch {}

    // If title has an extension, use it
    if (title && /\.\w{2,5}$/.test(title)) {
      return title;
    }

    // Title without extension — try to infer extension from URL
    const ext = url.match(/\.(png|jpg|jpeg|gif|svg|webp|pdf|mp4|mov|zip)/i)?.[1] ?? 'png';
    return `${title || 'attachment'}.${ext}`;
  }

  private ensureClient(): void {
    if (!this.client) {
      throw new Error('LinearService not initialized. Call initialize() first.');
    }
  }
}
