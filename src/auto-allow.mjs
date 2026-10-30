import { approvalResult } from './core.mjs';
import { mcpToolApproval, mcpApprovalResult } from './mcp-approval.mjs';

// Only known approval protocols qualify. Questions, login flows and forms do not.
export function automaticApproval(request) {
  if (mcpToolApproval(request)) return mcpApprovalResult(request, 'accept');
  if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
    'item/permissions/requestApproval'].includes(request.method)) return null;
  if (request.method === 'item/permissions/requestApproval'
      && (!request.params?.permissions || typeof request.params.permissions !== 'object'
        || Array.isArray(request.params.permissions))) return null;
  if (request.params?.availableDecisions && !request.params.availableDecisions.includes('accept')) return null;
  return approvalResult(request, 'accept');
}

export class AutoAllow {
  constructor(state, pending, { respond, approved = () => {}, owner = id => id }) {
    Object.assign(this, { state, pending, respond, approved, owner });
    this.state.data.autoAllowThreads ||= {};
    this.responded = new Set();
  }
  enabled(threadId) { return this.state.data.autoAllowThreads[this.owner(threadId)] === true; }
  enabledIds() { return Object.keys(this.state.data.autoAllowThreads).filter(id => this.enabled(id)); }
  set(threadId, enabled) {
    const previous = { ...this.state.data.autoAllowThreads };
    if (enabled) this.state.data.autoAllowThreads[threadId] = true;
    else delete this.state.data.autoAllowThreads[threadId];
    try { this.state.save(); }
    catch (error) { this.state.data.autoAllowThreads = previous; throw error; }
  }
  apply(key) {
    const entry = this.pending.entries.get(key);
    if (!entry) return false;
    const request = entry.request;
    const identity = JSON.stringify([request.params?.threadId, request.id]);
    // Suppress a replay even if the switch has since been turned off.
    if (this.responded.has(identity)) { this.pending.take(key); return true; }
    if (!this.enabled(request.params?.threadId)) return false;
    const result = automaticApproval(request);
    if (!result) return false;
    // No await between checking the switch, responding and removing the request.
    // A send failure leaves the request available for manual handling.
    this.respond(request.id, result);
    this.responded.add(identity);
    this.pending.take(key);
    this.approved(request);
    return true;
  }
  disconnected() { this.responded.clear(); }
}
