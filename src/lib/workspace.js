// workspace.js — one crew member, one repo. Enforced here rather than documented elsewhere.
//
// Why this is a module and not a paragraph in the README:
//
// Humans hesitate before editing code they don't own. Agents don't. Point two agents at
// the same tree and they will each finish their own half of the same file, confidently,
// and you get to spend a day working out which half is real. Worse, an agent that writes
// directly into a deployment tree turns the next fast-forward pull into an error, and the
// whole release lane stops — days later, with the cause four commits back.
//
// So: assignment is a checked operation. An agent may only be given work whose repo is in
// its `repos` list, and only the single agent with `canMerge` may take an order through
// the merge gate.

class WorkspaceRules {
  /**
   * @param {Array} agents normalized agent configs
   */
  constructor(agents) {
    this.byId = new Map(agents.map((a) => [a.id, a]));
    this.mergeGate = agents.find((a) => a.canMerge) || null;
  }

  get(id) { return this.byId.get(id) || null; }

  /**
   * May `agentId` be assigned an order belonging to `repo`?
   * An order with no repo is unscoped (docs, chores) and allowed anywhere — being strict
   * there would just push people to invent a fake repo name.
   * An agent with no `repos` list is unrestricted, which is the sane default for a
   * single-repo setup where the whole feature would otherwise be noise.
   */
  canWork(agentId, repo) {
    const a = this.get(agentId);
    if (!a) return { ok: false, reason: `unknown agent "${agentId}"` };
    if (!repo) return { ok: true };
    if (!a.repos || a.repos.length === 0) return { ok: true };
    if (a.repos.includes(repo)) return { ok: true };
    return {
      ok: false,
      reason: `"${agentId}" does not own repo "${repo}" (owns: ${a.repos.join(', ') || 'none'}) — ` +
              `assign it to whoever does instead of letting it edit a tree it doesn't manage`,
    };
  }

  /** Who should this repo's work go to? Useful for error messages and for routing hints. */
  ownersOf(repo) {
    if (!repo) return [...this.byId.keys()];
    return [...this.byId.values()].filter((a) => (a.repos || []).includes(repo)).map((a) => a.id);
  }

  /** Only the single merge-gate agent may push an order past review. */
  canMerge(agentId) {
    if (!this.mergeGate) {
      return { ok: false, reason: 'no agent has canMerge:true — nobody is allowed to merge' };
    }
    if (this.mergeGate.id !== agentId) {
      return { ok: false, reason: `only "${this.mergeGate.id}" may merge (single gate); "${agentId}" may not` };
    }
    return { ok: true };
  }

  /** Agents whose lane ends at human acceptance instead of the audit gate. */
  isSelfManaged(agentId) {
    const a = this.get(agentId);
    return !!(a && a.selfManaged);
  }
}

module.exports = { WorkspaceRules };
