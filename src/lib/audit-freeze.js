// audit-freeze.js — bind every review decision to one immutable delivery snapshot.

function createAuditFreeze(store) {
  const freezeTransaction = store.db.transaction((order, actor) => {
    store.order.freeze.run(order.id);
    const current = store.order.getById.get(order.id);
    store.orderRevision.insert.run(
      current.id,
      current.audit_revision,
      current.git_branch || null,
      current.commit_hash || null,
      current.files_changed || null,
      actor || 'system',
    );
    return {
      audit_revision: current.audit_revision,
      snapshot: store.orderRevision.get.get(current.id, current.audit_revision),
    };
  });

  function freeze(order, actor) {
    return freezeTransaction(order, actor);
  }

  function unfreeze(order) {
    store.order.setFrozen.run(0, order.id);
  }

  function applyOnTransition(order, fromStatus, toStatus, actor) {
    if (toStatus === 'auditing' && fromStatus !== 'auditing') {
      return { frozen: freeze(order, actor) };
    }
    if (fromStatus === 'auditing' && toStatus !== 'auditing') {
      unfreeze(order);
      return { unfrozen: true };
    }
    return {};
  }

  function freezeBlocks(order) {
    if (!order || !order.frozen) return null;
    return {
      error: `${order.id} is frozen at revision ${order.audit_revision}; unfreeze it before changing delivery fields`,
      audit_revision: order.audit_revision,
    };
  }

  function checkRevision(order, toStatus, cancelled, claimedRevision) {
    const bindsDecision = order.status === 'auditing'
      && (toStatus === 'pending_restart' || toStatus === 'rejected'
        || (toStatus === 'closed' && cancelled !== true));
    if (!bindsDecision || order.audit_revision <= 0) return { ok: true };
    if (claimedRevision === undefined || claimedRevision === null || claimedRevision === '') {
      return { ok: false, status: 400, error: `audit_revision is required for revision ${order.audit_revision}` };
    }
    const claimed = Number(claimedRevision);
    if (!Number.isInteger(claimed) || claimed !== order.audit_revision) {
      return {
        ok: false,
        status: 409,
        error: `you reviewed revision ${claimedRevision}; the current revision is ${order.audit_revision}`,
        audit_revision: order.audit_revision,
      };
    }
    return { ok: true };
  }

  return { freeze, unfreeze, applyOnTransition, freezeBlocks, checkRevision };
}

module.exports = { createAuditFreeze };
